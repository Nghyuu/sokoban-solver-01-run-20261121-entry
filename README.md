[![make.fun bounty](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Nghyuu/sokoban-solver-01-run-20261121-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Nghyuu/sokoban-solver-01-run-20261121-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

# Sokoban solver — push-optimal, room by room

Entry for [make.fun's "Build the best Sokoban solver, 21 November 2026" bounty](https://make.fun/bounty/sokoban-solver-01-run-20261121): a program that answers every instance of a set in one run, in as few pushes as possible.

## How it works

A level is a hallway one square wide with rooms off it, one door each, and
a box pushed through a door never comes back — so every room is solved on
its own, from its door, and the level's push count is the sum of the
rooms'. Each room (3–4 boxes) is solved by A* over pushes: a state is the
boxes plus the player's reachable region, the cost is pushes, the estimate
is the cheapest assignment of boxes to goals, and dead squares (from
pull-reachability) plus 2×2 freezes prune hopeless states. Moves between
pushes are shortest walks; only pushes count toward the score, so the
stitching walks are free. Everything is budgeted by work, never by the
clock, so two runs answer byte for byte the same.

## Practice results

On the kit's practice set the solver takes the push-optimal count on all
five instances (13, 16, 29, 47, 60 pushes) for a perfect score of
1,000,000 — against the house baseline's 200,000. Three further sets drawn
from the same generator with fresh seeds also score 1,000,000 each. A full
set solves in about 0.4 seconds on one CPU, far inside the 60-second wall
budget.

## Run it

```sh
MAKEFUN_INPUT_DIR=<input dir> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

`main.ts` is the whole entry: Node 22, standard library only, no
dependencies, no network, no clock.
