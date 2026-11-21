// Sokoban solver: push-optimal, room by room.
//
// A level is a hallway one square wide with rooms off it, one door each;
// a box pushed through a door never comes back, so every room is solved
// on its own, from its door, and the level's push count is the sum of the
// rooms'. Each room (3-4 boxes) is solved by A* over pushes: a state is
// the boxes plus the player's reachable region, the cost is pushes, the
// estimate is the cheapest assignment of boxes to goals, and dead squares
// (from pull-reachability) plus 2x2 freezes prune hopeless states. Moves
// between pushes are shortest walks; only pushes count toward the score,
// so the stitching walks are free. Everything is budgeted by work, never
// by the clock, so two runs answer byte for byte the same.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Neighbour order, fixed everywhere: up, down, left, right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const LETTER = ['u', 'd', 'l', 'r'];

// Work budgets (expansions). A room is tiny; these caps are a safety net,
// not the clock: the same input always costs the same work.
const ROOM_EXPANSIONS = 400_000;
const WHOLE_EXPANSIONS = 1_000_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const goalSet = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goals.push(i);
        goalSet[i] = 1;
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

// Flood fill from `start` over cells where open[i] is 1 and not blocked.
// Returns the seen set and its smallest cell (the region's representative).
function regionOf(
  start: number,
  w: number,
  h: number,
  open: Uint8Array,
  blocked: Uint8Array,
): { seen: Uint8Array; rep: number } {
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  let rep = start;
  while (stack.length > 0) {
    const u = stack.pop()!;
    if (u < rep) rep = u;
    const ux = u % w;
    const uy = Math.floor(u / w);
    for (let d = 0; d < 4; d++) {
      const nx = ux + DX[d]!;
      const ny = uy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = ny * w + nx;
      if (!open[v] || blocked[v] || seen[v]) continue;
      seen[v] = 1;
      stack.push(v);
    }
  }
  return { seen, rep };
}

// Cells a box can stand on and still reach a goal, by pull-reachability:
// a box on a live cell can be pulled toward a goal; a box on a dead cell
// can never get there. From a live cell y, the neighbour x = y + d is live
// when x and the cell past it, x + d, are both open (the player needs room
// to pull through). Goals are live by definition.
function liveCells(
  open: Uint8Array,
  goals: number[],
  w: number,
  h: number,
): Uint8Array {
  const live = new Uint8Array(w * h);
  const queue: number[] = [];
  for (const g of goals) {
    if (open[g] && !live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const y = queue[qi]!;
    const yx = y % w;
    const yy = Math.floor(y / w);
    for (let d = 0; d < 4; d++) {
      const nx = yx + DX[d]!;
      const ny = yy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const x = ny * w + nx;
      if (!open[x] || live[x]) continue;
      const bx = nx + DX[d]!;
      const by = ny + DY[d]!;
      if (bx < 0 || by < 0 || bx >= w || by >= h) continue;
      if (!open[by * w + bx]) continue;
      live[x] = 1;
      queue.push(x);
    }
  }
  return live;
}

// Shortest box-travel distances from each goal over `cells` (box moves
// cell to cell through open floor). dist[g][c] is Infinity where unreachable.
function goalDistances(
  goals: number[],
  cells: Uint8Array,
  w: number,
  h: number,
): number[][] {
  const out: number[][] = [];
  for (const g of goals) {
    const dist = new Array<number>(w * h).fill(Infinity);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const u = queue[qi]!;
      const ux = u % w;
      const uy = Math.floor(u / w);
      for (let d = 0; d < 4; d++) {
        const nx = ux + DX[d]!;
        const ny = uy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = ny * w + nx;
        if (!cells[v] || dist[v] !== Infinity) continue;
        dist[v] = dist[u]! + 1;
        queue.push(v);
      }
    }
    out.push(dist);
  }
  return out;
}

// Cheapest one-to-one assignment of boxes to goals (admissible: each box
// travels its own shortest path, ignoring the others). Small n: try every
// matching. Larger n: sum each box's nearest goal (still admissible).
function assignmentEstimate(
  boxes: number[],
  dist: number[][],
): number {
  const n = boxes.length;
  if (n === 0) return 0;
  if (n > 5) {
    let total = 0;
    for (const b of boxes) {
      let best = Infinity;
      for (let g = 0; g < dist.length; g++) {
        const d = dist[g]![b]!;
        if (d < best) best = d;
      }
      if (best === Infinity) return Infinity;
      total += best;
    }
    return total;
  }
  const used = new Array<boolean>(dist.length).fill(false);
  let best = Infinity;
  const rec = (i: number, total: number): void => {
    if (total >= best) return;
    if (i === n) {
      best = total;
      return;
    }
    for (let g = 0; g < dist.length; g++) {
      if (used[g]) continue;
      const d = dist[g]![boxes[i]!]!;
      if (d === Infinity) continue;
      used[g] = true;
      rec(i + 1, total + d);
      used[g] = false;
    }
  };
  rec(0, 0);
  return best;
}

interface Push {
  box: number;
  dir: number;
}

interface SearchOpts {
  // Cells boxes may occupy.
  boxCells: Uint8Array;
  // Cells the player may stand on (boxCells plus entry cells).
  open: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  // A goal state must also let the player reach this cell (room door);
  // -1 where there is none.
  exitCell: number;
  maxExpansions: number;
}

// A* over pushes. Returns the push list from start to a solved state, or
// null when the budget runs out or no solution exists.
function pushAStar(
  w: number,
  h: number,
  startBoxes: number[],
  startPlayer: number,
  opts: SearchOpts,
): Push[] | null {
  const live = liveCells(opts.open, opts.goals, w, h);
  const dist = goalDistances(opts.goals, opts.boxCells, w, h);
  const open = opts.open;
  const boxCells = opts.boxCells;

  const keyOf = (boxes: number[], rep: number): string =>
    boxes.join(',') + '|' + rep;

  // State stores, indexed by state id.
  const sb: number[][] = [];
  const sp: number[] = []; // player representative cell
  const sg: number[] = []; // pushes so far
  const parent: number[] = [];
  const pbox: number[] = [];
  const pdir: number[] = [];
  const best = new Map<string, number>();

  const blockedOf = (boxes: number[]): Uint8Array => {
    const blocked = new Uint8Array(w * h);
    for (const b of boxes) blocked[b] = 1;
    return blocked;
  };

  const startRegion = regionOf(startPlayer, w, h, open, blockedOf(startBoxes));
  const s0 = 0;
  sb.push(startBoxes.slice());
  sp.push(startRegion.rep);
  sg.push(0);
  parent.push(-1);
  pbox.push(-1);
  pdir.push(-1);
  best.set(keyOf(startBoxes, startRegion.rep), s0);

  // Heap entries [f, h, seq, state]; smallest first, seq breaks ties so
  // the order is the same on every run.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (
    a: [number, number, number, number],
    b: [number, number, number, number],
  ): boolean =>
    a[0] < b[0] ||
    (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  const startEst = assignmentEstimate(startBoxes, dist);
  if (startEst === Infinity) return null;
  heapPush([startEst, startEst, seq++, s0]);

  const solved = (boxes: number[], regionSeen: Uint8Array): boolean => {
    for (const b of boxes) if (!opts.goalSet[b]) return false;
    if (opts.exitCell >= 0 && !regionSeen[opts.exitCell]) return false;
    return true;
  };

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = sb[s]!;
    const rep = sp[s]!;
    const g = sg[s]!;
    if (best.get(keyOf(boxes, rep)) !== s) continue; // stale entry
    const blocked = blockedOf(boxes);
    const region = regionOf(rep, w, h, open, blocked);
    if (solved(boxes, region.seen)) {
      const pushes: Push[] = [];
      for (let t = s; t > 0; t = parent[t]!) {
        pushes.push({ box: pbox[t]!, dir: pdir[t]! });
      }
      pushes.reverse();
      return pushes;
    }
    if (expanded >= opts.maxExpansions) return null;
    expanded++;
    const boxSet = new Set(boxes);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const dx = b + DX[d]! + DY[d]! * w;
        const behind = b - DX[d]! - DY[d]! * w;
        if (!boxCells[dx] || boxSet.has(dx)) continue;
        if (!open[behind] || !region.seen[behind]) continue;
        const nb = boxes.slice();
        nb[bi] = dx;
        nb.sort((a, bb) => a - bb);
        // Dead square: a box off its goal that can never reach one.
        let dead = false;
        for (const x of nb) {
          if (!opts.goalSet[x] && !live[x]) {
            dead = true;
            break;
          }
        }
        if (dead) continue;
        // 2x2 freeze around the moved box: four wall-or-box cells with a
        // box off its goal cannot be broken apart.
        const nx = dx % w;
        const ny = Math.floor(dx / w);
        for (let oy = -1; oy <= 0 && !dead; oy++) {
          for (let ox = -1; ox <= 0 && !dead; ox++) {
            const cx = nx + ox;
            const cy = ny + oy;
            if (cx < 0 || cy < 0 || cx + 1 >= w || cy + 1 >= h) continue;
            const cells = [
              cy * w + cx,
              cy * w + cx + 1,
              (cy + 1) * w + cx,
              (cy + 1) * w + cx + 1,
            ];
            let filled = true;
            let hasBox = false;
            for (const c of cells) {
              if (open[c] && !nb.includes(c)) {
                filled = false;
                break;
              }
              if (nb.includes(c) && !opts.goalSet[c]) hasBox = true;
            }
            if (filled && hasBox) dead = true;
          }
        }
        if (dead) continue;
        const nblocked = blockedOf(nb);
        const nregion = regionOf(b, w, h, open, nblocked);
        const est = assignmentEstimate(nb, dist);
        if (est === Infinity) continue;
        const k = keyOf(nb, nregion.rep);
        const seenState = best.get(k);
        if (seenState !== undefined && sg[seenState]! <= g + 1) continue;
        const t = sb.length;
        sb.push(nb);
        sp.push(nregion.rep);
        sg.push(g + 1);
        parent.push(s);
        pbox.push(b);
        pdir.push(d);
        best.set(k, t);
        heapPush([g + 1 + est, est, seq++, t]);
      }
    }
  }
  return null;
}

// Shortest walk from `from` to `to` over open cells avoiding `boxes`.
// Fixed neighbour order, so the path is the same on every run.
function walkPath(
  w: number,
  h: number,
  open: Uint8Array,
  boxes: number[],
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const blocked = new Uint8Array(w * h);
  for (const b of boxes) blocked[b] = 1;
  const prev = new Int32Array(w * h).fill(-2);
  const prevDir = new Int8Array(w * h).fill(-1);
  prev[from] = -1;
  const queue = [from];
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi]!;
    if (u === to) break;
    const ux = u % w;
    const uy = Math.floor(u / w);
    for (let d = 0; d < 4; d++) {
      const nx = ux + DX[d]!;
      const ny = uy + DY[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const v = ny * w + nx;
      if (!open[v] || blocked[v] || prev[v] !== -2) continue;
      prev[v] = u;
      prevDir[v] = d;
      queue.push(v);
    }
  }
  if (prev[to] === -2) return null;
  let moves = '';
  for (let u = to; u !== from; u = prev[u]!) {
    moves = LETTER[prevDir[u]!]! + moves;
  }
  return moves;
}

interface Room {
  cells: number[];
  doorRoom: number; // room-side cell of the door edge
  doorHall: number; // hallway-side cell of the door edge
  boxes: number[];
  goals: number[];
}

// Split a level into rooms: the hallway is the player's row; removing it
// leaves one component per room, each with one door onto the hallway.
// Returns null when the level does not fit that shape.
function decompose(level: Level): Room[] | null {
  const { w, h, wall } = level;
  const hallRow = Math.floor(level.player / w);
  // Nothing the player must move may sit in the hallway itself.
  for (const b of level.boxes) {
    if (Math.floor(b / w) === hallRow) return null;
  }
  for (const g of level.goals) {
    if (Math.floor(g / w) === hallRow) return null;
  }
  const open = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) open[i] = wall[i] ? 0 : 1;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const boxSet = new Set(level.boxes);
  const goalSet = level.goalSet;
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || seen[s] || Math.floor(s / w) === hallRow) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const u = stack.pop()!;
      comp.push(u);
      const ux = u % w;
      const uy = Math.floor(u / w);
      for (let d = 0; d < 4; d++) {
        const nx = ux + DX[d]!;
        const ny = uy + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = ny * w + nx;
        if (wall[v] || seen[v] || ny === hallRow) continue;
        seen[v] = 1;
        stack.push(v);
      }
    }
    const boxes = comp.filter((c) => boxSet.has(c));
    if (boxes.length === 0) continue;
    const goals = comp.filter((c) => goalSet[c] === 1);
    if (boxes.length !== goals.length) return null;
    // Door edges: a room cell next to a hallway-row floor cell.
    const doors: [number, number][] = [];
    const compSet = new Set(comp);
    for (const u of comp) {
      const ux = u % w;
      const uy = Math.floor(u / w);
      for (let d = 0; d < 4; d++) {
        const nx = ux + DX[d]!;
        const ny = uy + DY[d]!;
        if (ny !== hallRow || nx < 0 || nx >= w) continue;
        const v = ny * w + nx;
        if (!wall[v] && !compSet.has(v)) doors.push([u, v]);
      }
    }
    if (doors.length !== 1) return null;
    rooms.push({
      cells: comp,
      doorRoom: doors[0]![0],
      doorHall: doors[0]![1],
      boxes: boxes.sort((a, b) => a - b),
      goals: goals.sort((a, b) => a - b),
    });
  }
  if (rooms.length === 0) return null;
  const counted = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (counted !== level.boxes.length) return null;
  // Deterministic room order: by door position along the hallway.
  rooms.sort((a, b) => a.doorHall - b.doorHall);
  return rooms;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { w, h, wall } = level;
  const open = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) open[i] = wall[i] ? 0 : 1;

  const rooms = decompose(level);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    const boxes = level.boxes.slice();
    for (const room of rooms) {
      // Walk to this room's door.
      const toDoor = walkPath(w, h, open, boxes, player, room.doorHall);
      if (toDoor === null) return '';
      moves += toDoor;
      player = room.doorHall;
      // Solve the room from its door; boxes stay inside it.
      const roomCells = new Uint8Array(w * h);
      for (const c of room.cells) roomCells[c] = 1;
      const roomOpen = roomCells.slice();
      roomOpen[room.doorHall] = 1;
      const pushes = pushAStar(w, h, room.boxes, room.doorHall, {
        boxCells: roomCells,
        open: roomOpen,
        goals: room.goals,
        goalSet: level.goalSet,
        exitCell: room.doorHall,
        maxExpansions: ROOM_EXPANSIONS,
      });
      if (pushes === null) return '';
      // Replay the pushes, walking between them.
      const roomBoxSet = new Set(room.boxes);
      for (const push of pushes) {
        const behind = push.box - DX[push.dir]! - DY[push.dir]! * w;
        const walk = walkPath(w, h, roomOpen, boxes, player, behind);
        if (walk === null) return '';
        moves += walk;
        moves += LETTER[push.dir]!;
        const dest = push.box + DX[push.dir]! + DY[push.dir]! * w;
        const at = boxes.indexOf(push.box);
        boxes[at] = dest;
        boxes.sort((a, b) => a - b);
        roomBoxSet.delete(push.box);
        roomBoxSet.add(dest);
        player = push.box;
      }
    }
    for (const b of boxes) if (!level.goalSet[b]) return '';
    return moves;
  }

  // Fallback: the whole level as one push search.
  const pushes = pushAStar(w, h, level.boxes, level.player, {
    boxCells: open,
    open,
    goals: level.goals,
    goalSet: level.goalSet,
    exitCell: -1,
    maxExpansions: WHOLE_EXPANSIONS,
  });
  if (pushes === null) return '';
  let moves = '';
  let player = level.player;
  const boxes = level.boxes.slice();
  for (const push of pushes) {
    const behind = push.box - DX[push.dir]! - DY[push.dir]! * w;
    const walk = walkPath(w, h, open, boxes, player, behind);
    if (walk === null) return '';
    moves += walk;
    moves += LETTER[push.dir]!;
    const dest = push.box + DX[push.dir]! + DY[push.dir]! * w;
    const at = boxes.indexOf(push.box);
    boxes[at] = dest;
    boxes.sort((a, b) => a - b);
    player = push.box;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
