# CONCEPTS

Words that mean something specific in this project. Each entry stands on its own — no code, no
history, no prior context required.

## Runner

The separate operating-system process that actually performs a transfer. It is deliberately
detached from whatever started it, so it keeps running after its parent exits.

This exists because the host application unloads a command's process as soon as the user dismisses
the window. Work owned by that process dies with it, mid-write. Handing the transfer to a process
the host does not own is the only way for it to survive dismissal.

A runner cannot use anything from the host environment, because it runs outside it. It reports
progress by writing a [status file](#status-file) rather than by returning values or calling back,
since there is nothing left in memory to report to.

## Status file

The on-disk record of one transfer's state — how far it has got, whether it is still going, and
how it ended.

It is the project's only channel between processes. Every command is a separate process with no
shared memory, so a status file is how a window opened a minute from now learns about a transfer
started by a window that has since closed.

Writes are atomic: the content is written elsewhere and moved into place, so a reader never sees a
half-written record. That same property rules out watching the file for changes — the move
replaces the file a watcher was attached to — so readers poll instead.

## Layer A and Layer B

The two halves of the public interface, kept deliberately independent.

**Layer A** is the transport: it fetches from a URL, supervises the [runner](#runner), and tracks
progress. **Layer B** is everything useful to any caller that puts a file on disk regardless of how
it got the bytes — choosing a safe filename, classifying errors, formatting progress, recording
history.

The split is load-bearing rather than tidy. Some tools own their own transport: they never expose a
URL, choose their own destination, and report no progress. Such a tool can use Layer B completely
while Layer A is structurally unusable to it. So Layer B must never depend on Layer A — collapsing
them would force every caller through a URL-shaped interface that does not fit all of them.

## Partial file

The incomplete copy a transfer writes to, under a name distinct from the one the user asked for,
until the result has been verified and can be published under the real name.

It carries three jobs at once, which is why it is worth naming. It holds the bytes a later attempt
resumes from; it doubles as the [reservation](#reservation) on the final name; and its presence
after a failure is the signal that resuming is worthwhile at all. Whether those bytes may actually
be appended to is a separate question, answered by their [provenance](#provenance) rather than by
their number. Those jobs conflict: the bytes
are only resumable if every byte in the file genuinely belongs to the wanted file, so anything a
failed attempt wrote — an error page, a redirect body — must be rolled back before the file is left
behind, and a rollback that cannot be verified means the file must be discarded instead — or,
when even deletion is denied, marked unsafe so no later attempt resumes onto it.
Publishing is a rename of this file, which is what makes the final name appear only once the
content behind it is whole.

## Provenance

What is recorded alongside a [partial file](#partial-file) about where its bytes came from: which
resource they were fetched from, and the server's own description of that resource at the time.

It exists because a byte count is not evidence. Resuming asks a server to continue from an offset,
and that request asserts the bytes already held are a correct prefix of what is being fetched — an
assertion the server takes on trust and no later check can catch, because the result has exactly
the length it should. Only the process that wrote the prefix knows what the prefix is, so it has to
write that down for whoever comes next.

Provenance is recorded as soon as the response arrives rather than when the transfer ends: the
transfers that most need to be resumable are the ones that never end, so recording at the end would
produce partials that can never be resumed precisely in the cases resuming exists for.

## Path claim

A statement that one attempt is writing to a particular destination right now, held for as long as
that attempt runs.

Distinct from a [reservation](#reservation), which says a name is spoken for, and from a
[lease](#lease), which says which window is presenting a transfer. This says which process owns the
bytes. It is required because two transfers with different identifiers can target one destination,
and the second one's resume appends to the first one's bytes — a conflict neither of the other two
can see, because both are scoped to something other than the destination.

Taking a claim must be atomic in the filesystem's own terms and must publish its contents in the
same step, since a claim observed half-written is read as no claim at all. Releasing one names its
holder: a release that means "remove whatever is here" will remove a later attempt's claim when an
earlier attempt's cleanup arrives late. A claim whose owner is provably gone is stolen, or a
crashed attempt would hold a destination forever.

## Reservation

An atomic claim on a filename, made before anything is written to it.

Picking an unused name and returning it is not enough when the caller writes later: two callers can
inspect the same directory in the same moment, see the same name free, and both take it. A
reservation instead creates the [partial file](#partial-file) as its marker, in a way the
filesystem guarantees only one caller can win, so the name is genuinely held rather than merely observed to be free.

Whoever takes a reservation is responsible for releasing it if the work does not proceed. An
abandoned reservation burns that filename for later callers.

## Lease

A claim by one window that it is the one presenting a given transfer to the user.

It prevents two open windows from both adopting the same in-flight transfer and fighting over it.
A lease is best-effort and deliberately not a distributed guarantee — it is scoped to the realistic
case of a person opening a second window moments later, not to arbitrating between hosts.

## Attempt identity

What distinguishes one run of a transfer from a later retry that reuses the same identifier.

An identifier alone cannot do this: the user can cancel and retry, and the new attempt takes the
same name. Identity therefore pairs the operating-system process with when that process started,
because process numbers are recycled — a number alone will eventually point at some unrelated
program, and acting on that mistake means reporting the wrong outcome or signalling the wrong
process entirely.

Nearly every correctness rule in the project reduces to asking whether two observations describe
the same attempt. Deleting a record, cancelling a transfer, and deciding whether a result may
overwrite an earlier one are all the same question.

## Flagged ambiguities

- **Reservation vs. path claim vs. lease.** Three claims on three different things, and conflating
  them silently removes a guarantee. A reservation holds a NAME so two callers do not choose it. A
  path claim holds a DESTINATION so two attempts do not write to it. A lease holds a PRESENTATION so
  two windows do not both narrate one transfer. An attempt can hold all three at once; losing any
  one of them breaks something the others still appear to cover.
- **Abandoned vs. finished.** An attempt observed as "no longer running" has two meanings that must
  not be conflated: it died, or it completed while nobody was watching. Treating the second as the
  first discards a successful result.
