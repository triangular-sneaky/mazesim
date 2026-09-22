# Stateful panel control

## Requirements

### Objective

We can control virtual maze by specifying position and light of each panel. Now, we need to adapt this to real maze. I think it's helpful to keep current abstraction of setting position and light intensity of each panel, but reality is more complicated, and we may need to sacrifice this.

### Math model

1. Maze movement can only be controlled incrementally. 
2. it has internal phase state: (v,z) where z is its logical height coordinate `[0..N]` where N=8, and v is motion direction {1,-1} where 1 is up. 
3. Each note on (separated by note off, so can be thought as note off + note on pair) moves a panel to `z* = z + v`. once it reaches the end of the interval, direction reverses.
4. It can be thought of as a circular motion where position is angular coordinate `alpha = vzs+pi(1-v)` where s is one step in angular coordinates `s=pi/N`. this way right is 0, left is N. (validate this hypothesis). Normalized by s, we can say coordinate `a(z,v) = vz + N(1-v)`
5. Let rotation_distance(alpha, beta) = <angle counterclockwise from alpha to beta> and rotation_steps(a,b) normalized by s accordingly `rotation_steps(a,b) = rotation_distance(alpha, beta) * N / pi`
6. Step distance to arrive at height z' (if z != z') is: `step_distance(z,z') = min(rotation_steps(a(z,v), a(z',1)), rotation_steps(a(z,v), a(z',-1)))` 
7. Step distance to do nothing (useful to control light only or during scene init, see below): `stay(z) = rotation_steps(a(z,v), a(z,-v))`

Validate the math before going into coding. 

### State machine

#### Movement state

1. For each panel, we need to track its z and v. 
2. This needs to be stateful, persisted after every change, its critical to be able to control maze position

#### Light

1. Light on must coincide with motion trigger (note on). Note velocity is brightness, `[1..127]` where 1 is off.
2. To trigger light without panel motion, we must do `stay(z)`. 
3. When moving more than 1 steps, all note on should have the same velocity. note off velocity is ignored


### Nonfuncitonal 
#### Guards
running average rate limit, burst limit, time delay between messages - as currently (we might need to improve). These guards must be non-negotiable, but movement code is allowed to optimize for them 

#### Optimizations
1. We must minimize number of messages overall, and ideally number of messages sent to a single panel. Propose ideas.
2. Some ideas:
  - every new movement (we will call it Scene now) can start with longer gradual period of init. We can rate limit messages, moving groups of panels one by one
  - during init, we can set v of each panel so it lowers subsequent movement budget

### Error correction, sync with reality, and reset

1. Maze might glitch and drop messages. I will observe unexpected movements and need a way to error correct.

#### HUD

1. I need to see each panel (with note number and coordinate and v/h as before and its tracked z and v, graphincally and numerically). 
2. I should be able to do the following for each panel: 
  1. flip v (basically stay operation). 2 flavors: send stay and flip our tracked v ("flip"), and "correct" to flip our tracked v without sending stay
  2. move 1 step per click (can click multiple times)
  3. mark as dead (grey out in gui and ban sending any messages to it)
3. This needs to be switchable between 2d top view and a virtual maze view. In latter mode, the normal 3d render is overlaid with these controls. 

#### Reset

1. Button to send 1 step to each panel (respecting all the guards). will do "correct" and move individually after.