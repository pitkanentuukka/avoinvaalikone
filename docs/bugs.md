# Known minor bugs

Bugs that are unlikely to happen and not serious if they do, so they are not
worth a GitHub issue for now. Revisit this list when working in the same code,
or when one turns out to be more likely or more serious than estimated. Then
file it as an issue and remove it here. When fixing one, remove its entry.

Each entry lists where it is, steps to reproduce, expected and actual
behaviour, how likely it is and how serious, and where it was found.

## Admin: an older list reload can overwrite a newer one

**Where:** `refresh()` in `AdminView` (`vaalikone-frontend/src/App.jsx`)

Every admin action reloads the party and question-set lists when it succeeds.
When two actions overlap, their reloads can finish out of order, and the
older one's response replaces the newer one's.

1. **Steps:** delete party X. While its list reload is in flight, add party Y,
   whose reload finishes first.
2. **Expected:** the list shows Y.
3. **Actual:** X's reload, answered before Y was created, lands last. Y is
   missing until the next reload.

- **Likelihood:** low. It needs two overlapping actions and reloads that finish
  out of order. Overlapping actions have been supported since #225.
- **Severity:** low. Only the display is wrong: the data is saved, and the next
  reload shows it.
- **Possible fix:** a sequence counter in `refresh()` that drops responses older
  than the latest request.
- **Found:** review of PR #236 (#225).

## Admin: text typed during a slow party creation is erased

**Where:** `addParty()` in `AdminView` (`vaalikone-frontend/src/App.jsx`)

The name and email fields stay editable while *Lisää* is running, and a
successful creation clears them.

1. **Steps:** click *Lisää* on a slow backend, then start typing the next
   party's name.
2. **Expected:** the new text is kept.
3. **Actual:** the fields are cleared when the first creation succeeds.

- **Likelihood:** low. It needs a slow backend and an admin who starts the next
  entry before the first is saved.
- **Severity:** low. The admin retypes a name, and nothing is saved wrong.
- **Possible fix:** clear the fields only if they still hold the submitted
  values, or disable them while the creation runs.
- **Found:** review of PR #236 (#225).

## Admin: error messages don't follow a language switch

**Where:** `AdminView`'s error state (`vaalikone-frontend/src/App.jsx`)

Errors are stored as translated strings when they happen, so the banner keeps
the language they were made in.

1. **Steps:** make an admin action fail, e.g. with the backend down, then
   switch the language.
2. **Expected:** the banner follows the new language.
3. **Actual:** messages such as `t.requestFailed(…)` and
   `t.adminLinksRotatedRefreshFailed` stay in the old language until the next
   action clears them.

- **Likelihood:** low. The admin rarely switches language with an error showing.
- **Severity:** cosmetic.
- **Possible fix:** store the error (or a translation key and its arguments)
  and translate it when rendering.
- **Found:** review of PR #238 (#226).
