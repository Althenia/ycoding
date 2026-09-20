## A privacy-safe export of the user's own selected data.
##
## The acceptance is "CSV/JSON user action, formula-safe text, no secrets or auto public
## upload", and each clause rules out a specific harm:
##
##   A USER ACTION. This class only COMPOSES. `text()` builds the CSV and `text_json()` the
##   JSON; the disk is touched only by the explicit `write_csv`, so nothing is created that
##   the user did not ask for.
##
##   FORMULA-SAFE TEXT. A spreadsheet reads a cell starting with `=`, `+`, `-`, `@`, TAB or CR
##   as a FORMULA. A provider message carrying one therefore becomes executable content in the
##   user's own spreadsheet, which is why the kit requires formula-leading strings to be
##   escaped. THE DISTINCTION THAT MATTERS: a NEGATIVE NUMBER also begins with `-`, and it is
##   DATA. Escaping every `-`-leading cell would corrupt every negative figure, and an export
##   that mangles the numbers is as wrong as one that executes them. So a cell the caller
##   declares NUMERIC is written bare, and a cell carrying text is neutralised with a leading
##   apostrophe - the spreadsheet's own "this is text" marker, which keeps the original
##   readable.
##
##   NO SECRETS. Every value crosses `_sanitize`, which removes credential-shaped material
##   and machine-specific paths. A provider message can quote a request header, and an export
##   is a file that leaves the client's own surfaces.
##
##   NO AUTO PUBLIC UPLOAD. There is no network call anywhere on this path, and the class
##   holds no transport. `UPLOADS_NOTHING` states it, and `has_method` checks in the suite
##   prove no upload method exists.
class_name ExportBuilder
extends RefCounted

## What a redacted value becomes. A visible marker, so a reader can tell a redaction from
## content rather than wondering why a field is short.
const REDACTED := "[redacted]"

## The prefix that keeps a text cell from being read as a formula. An apostrophe is the
## spreadsheet convention for "the rest is literal text"; it is not rendered as part of the
## value.
const TEXT_GUARD := "'"

## The characters a spreadsheet treats as the start of a formula.
const FORMULA_TRIGGERS := ["=", "+", "-", "@", "\t", "\r"]

## The stated absence of any network behaviour on the export path.
const UPLOADS_NOTHING := (
	"The export writes a local file only: no network call is made and nothing is uploaded, " +
	"published or sent anywhere."
)

## The credential- and path-shaped material that never reaches an exported file. Matched
## case-insensitively; the key form requires a value so a bare word is not mistaken for a
## secret.
const SECRET_PATTERNS := [
	"(?i)\\b(password|passwd|api[_-]?key|secret|token|credential|authorization|bearer)\\b\\s*[:=]\\s*\\S+",
	"(?i)\\bbearer\\s+\\S+",
	"ghp_[A-Za-z0-9]{10,}",
	"sk-[A-Za-z0-9_-]{12,}",
	"AKIA[0-9A-Z]{16}",
	"xox[baprs]-[A-Za-z0-9-]{10,}",
	"-----BEGIN [A-Z ]*PRIVATE KEY-----",
]
## Machine-specific paths: an export that leaves this machine should not name its layout.
const PATH_PATTERNS := [
	"/Users/[A-Za-z0-9._-]+",
	"/home/[A-Za-z0-9._-]+",
	"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
]

## The columns every row carries. Named in the header, so a reader knows each field.
const COLUMNS := ["label", "value", "count", "spend"]

var _rows: Array[Dictionary] = []


## Note the file this export explains. Kept so a caller can name its own header later without
## changing the shape of the body.
var title := "Statistics export"


## Add rows to export. Each carries `label`, `value`, `count` and `spend`, where `count` and
## `spend` are NUMBERS and therefore never escaped as formulas.
func add_rows(rows: Array) -> void:
	for row in rows:
		if row is Dictionary:
			_rows.append(row)


func rows_count() -> int:
	return _rows.size()


## The CSV body.
##
## This is also the PREVIEW: the suite asserts it equals what `write_csv` writes, because a
## preview that differed from the file would tell the user nothing about what they are about
## to disclose.
##
## Each row is a header line followed by one line per row. `count` and `spend` are written
## numerically so a spreadsheet can compute with the columns; `label` and `value` are text
## and are guarded.
func text() -> String:
	var lines: Array[String] = []
	lines.append(_join_text(COLUMNS))
	for row in _rows:
		lines.append(",".join([
			_text_cell(str(row.get("label", ""))),
			_text_cell(str(row.get("value", ""))),
			_number_cell(row.get("count", 0)),
			_number_cell(row.get("spend", 0.0)),
		]))
	# A trailing newline, so the file ends with a complete record.
	return "\n".join(lines) + "\n"


## The JSON form.
##
## JSON is DATA rather than a spreadsheet, so a formula-leading value is preserved verbatim
## here: escaping it would corrupt the value for a JSON consumer, and no JSON reader executes
## it. Redaction still applies, so the two forms cannot disagree about what is safe to
## disclose.
func text_json() -> String:
	var rows: Array = []
	for row in _rows:
		rows.append({
			"label": _sanitize(str(row.get("label", ""))),
			"value": _sanitize(str(row.get("value", ""))),
			"count": _as_number(row.get("count", 0)),
			"spend": _as_number(row.get("spend", 0.0)),
		})
	return JSON.stringify({
		"title": title,
		"columns": COLUMNS,
		"rows": rows,
		"note": UPLOADS_NOTHING,
	}, "  ")


## Write the CSV where the user asked for it. Returns the write error so a caller reports it
## rather than assuming success.
func write_csv(path: String) -> Error:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	file.store_string(text())
	file.close()
	return OK


## Write the JSON where the user asked for it.
func write_json(path: String) -> Error:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	file.store_string(text_json())
	file.close()
	return OK


## A TEXT cell: sanitized, then guarded so a spreadsheet reads it as data.
func _text_cell(value: String) -> String:
	var sanitized := _sanitize(value)
	# The guard is added BEFORE quoting, so the apostrophe is inside the quoted field and the
	# spreadsheet sees it as part of the cell's own text.
	var guarded := sanitized
	if _needs_guard(sanitized):
		guarded = TEXT_GUARD + sanitized
	return _quote(guarded)


## A NUMERIC cell: written bare, so a spreadsheet computes with it.
##
## A number beginning with `-` is DATA and is NOT guarded. Guarding it would turn the column
## into text and break every arithmetic a reader would do on it.
func _number_cell(value: Variant) -> String:
	if value is int:
		return str(value)
	if value is float:
		var number: float = value
		if is_equal_approx(number, round(number)):
			return str(int(round(number)))
		return "%.2f" % number
	# A caller that passed text into a numeric column gets it treated as text, because the
	# value is not a number and claiming otherwise would be worse than the guard.
	return _text_cell(str(value))


## A cell needs the guard when it begins with a formula trigger.
func _needs_guard(value: String) -> bool:
	if value.is_empty():
		return false
	for trigger in FORMULA_TRIGGERS:
		if value.begins_with(trigger):
			return true
	return false


## Quote a field when it carries a quote, a comma or a newline, doubling embedded quotes.
func _quote(value: String) -> String:
	if not (value.contains("\"") or value.contains(",") or value.contains("\n") or value.contains("\r")):
		return value
	return "\"" + value.replace("\"", "\"\"") + "\""


func _join_text(values: Array) -> String:
	var out: Array[String] = []
	for value in values:
		out.append(_text_cell(str(value)))
	return ",".join(out)


## Remove credential-shaped material and machine-specific paths from a value.
##
## Applied to text cells AND to the JSON, so a secret cannot reach either form.
func _sanitize(value: String) -> String:
	var out := value
	for pattern in SECRET_PATTERNS:
		out = _replace_all(out, pattern)
	for pattern in PATH_PATTERNS:
		out = _replace_all(out, pattern)
	return out


func _replace_all(value: String, pattern: String) -> String:
	var regex := RegEx.create_from_string(pattern)
	if regex == null:
		return value
	return regex.sub(value, REDACTED, true)


func _as_number(value: Variant) -> Variant:
	if value is int or value is float:
		return value
	return _sanitize(str(value))
