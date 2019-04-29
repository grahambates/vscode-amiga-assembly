
**NAME**

AddTask -- add a task to the system

**SYNOPSIS**

```
    AddTask(task, initialPC, finalPC)
            A1    A2         A3

```
APTR AddTask(struct [Task](Task) *, APTR, APTR);

**FUNCTION**

Add a task to the system.  A reschedule will be run; the task with
the highest priority in the system will start to execute (this may
or may not be the new task).

Certain fields of the task control block must be initialized and a
stack allocated prior to calling this function.  The absolute
smallest stack that is allowable is something in the range of 100
bytes, but in general the stack size is dependent on what
subsystems are called. In general 256 bytes is sufficient if only
Exec is called, and 4K will do if anything in the system is called.
DO NOT UNDERESTIMATE.  If you use a stack sniffing utility,
leave a healthy pad above the minimum value.  The system guarantees
that its stack operations will leave the stack longword aligned.

This function will temporarily use space from the new task's stack
for the task's initial set of registers.  This space is allocated
starting at the SPREG location specified in the task control block
(not from SPUPPER).  This means that a task's stack may contain
static data put there prior to its execution.  This is useful for
providing initialized global variables or some tasks may want to
use this space for passing the task its initial arguments.

A task's initial registers are set to zero (except the PC).

The TC_MEMENTRY field of the task structure may be extended by
the user to hold additional MemLists (as returned by [AllocEntry](AllocEntry)).
These will be automatically be deallocated at [RemTask](RemTask) time.
If the code you have used to start the task has already added
something to the MEMENTRY list, simply use [AddHead](AddHead) to add your
new MemLists in.  If no initialization has been done, a [NewList](NewList) will
need to be performed.

**INPUTS**

task  - pointer to the task control block (TCB).  All unset fields
must be zero.
initialPC - the initial entry point's address
finalPC - the finalization code entry point's address.  If zero,
the system will use a general finalizer. This pointer is
placed on the stack as if it were the outermost return
address.

**RESULTS**

For V36, AddTask returns either a NULL or the address of the new
task.  Old code need not check this.

**WARNING**

Tasks are a low-level building block, and are unable to call
dos.library, or any system function that might call dos.library.
See the AmigaDOS [CreateProc](CreateProc) for information on Processes.

**SEE ALSO**

[RemTask](RemTask), [FindTask](FindTask), [amiga.lib/CreateTask](amiga.lib/CreateTask), [dos/CreateProc](dos/CreateProc),
[amiga.lib/NewList](amiga.lib/NewList)