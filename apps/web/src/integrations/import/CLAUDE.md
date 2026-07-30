# integrations/import

Owns turning a spreadsheet into dialable leads. Launched as a **modal from the
Dialer page** — it is not a page of its own.

## What this module does

- Parses `.csv`, `.xlsx`, and Apple `.numbers` with SheetJS.
- Previews the first 20 rows so the operator can see what they actually have.
- **Field mapping** with three modes per CRM field:
  1. **Map to column** — pick a spreadsheet header.
  2. **Ignore** — leave the field blank.
  3. **Fixed value** — type a string that gets written to *every* lead in this
     import. Typing `Henderson` into Company Location sets all imported leads to
     Henderson regardless of what the sheet says.
- Creates **custom fields inline** from the mapping screen, without leaving it.
- Normalizes every phone to **E.164** and rejects rows whose number cannot be a
  real dialable number.
- **Dedupes on phone number.** An existing contact is merged, not duplicated.
- Produces an import report: added / merged / rejected, with a reason per
  rejected row.
- Tags every import with a **list name** so it can be loaded as a dial session
  later.

## Env vars this folder owns

None. This module is fully local — no API keys, no network. It is the first
thing to build and test on a fresh clone because nothing else has to work first.

---

## Field notes

### Phone normalization

Spreadsheets mangle phone numbers in predictable ways, and all of these are
handled:

| In the sheet | Stored |
| --- | --- |
| `7025551234` | `+17025551234` |
| `(702) 555-1234` | `+17025551234` |
| `702-555-1234` | `+17025551234` |
| `17025551234` | `+17025551234` |
| `7025551234.0` (Excel made it a float) | `+17025551234` |
| `+44 20 7946 0958` | `+442079460958` |
| `555-1234` | **rejected** — not enough digits |
| `n/a`, blank | **rejected** — no phone |

A row with no valid phone is rejected rather than imported, because a lead you
cannot dial is not a lead — it is a row that will confuse the queue later.

### Dedupe and merge

Phone number is the identity key. On collision the existing contact is kept and
**only blank fields are filled in** from the new row. An import never
overwrites a value the operator already has, because the spreadsheet is almost
always staler than the CRM after a few calls.

The new list membership is still recorded, so the contact appears in the new
list's dial session.

### `.numbers` files

Apple Numbers files are zip archives, and SheetJS reads them directly — no
export step. If a `.numbers` file fails to parse, it was probably saved by a
very old version of Numbers; opening and re-saving it fixes that.

---

## Testing end to end

**1. All three formats parse**
Import the same 5 leads saved as `.csv`, `.xlsx`, and `.numbers`. All three
produce identical results.

**2. Preview is honest**
The first 20 rows shown match what is actually in the file, including
headers-with-spaces and unicode names.

**3. Fixed value mode** ← the distinctive one
Import a sheet whose Location column contains a mix of cities. Set Company
Location to **fixed value** `Henderson`. Every imported lead must show
`Henderson`, and the sheet's own values must be ignored entirely.

**4. Custom field created inline**
On the mapping screen, create a custom field called `Roof Type`, map a column to
it, import. The field appears on the contact, and becomes available in Settings
to toggle onto the Active Lead Card.

**5. Phone normalization**
Import a sheet containing each row from the table above. Confirm the stored
E.164 values, and confirm the two bad rows land in the rejected list with a
readable reason.

**6. Dedupe**
Import the same file twice. Second run reports every row as **merged**, not
added, and the contact count does not double.

Then edit one contact's company name in the app, re-import the original file,
and confirm your edit survived — the import must not clobber it.

**7. Real spreadsheet** ← the one that matters
Import an actual lead list you intend to dial. Check the report's rejected
count against what you expected. Then load that list as a dial session on the
Dialer page and confirm the leads appear in the queue in order.
