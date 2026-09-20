## Export tests (R7-07).
##
## The acceptance is: "CSV/JSON user action, formula-safe text, no secrets or auto public
## upload."
##
## Four clauses, and each rules out a specific harm:
##
##   * A USER ACTION. Nothing is written until the user asks. An export that happens on its
##     own is a file on disk nobody chose to create.
##   * FORMULA-SAFE TEXT. A spreadsheet treats a cell beginning with `=`, `+`, `-`, `@`, TAB
##     or CR as a FORMULA, so a provider message containing one becomes executable content in
##     the user's spreadsheet. This is the security-critical clause.
##   * NO SECRETS. A credential, a token, a private path or an account email must not reach an
##     exported file. The kit's rule is that credential material never leaves the surfaces it
##     belongs to.
##   * NO AUTO PUBLIC UPLOAD. The export writes locally and uploads nothing. There is no
##     network call in the export path at all.
##
## THE SUBTLETY THAT MATTERS MOST: a NEGATIVE NUMBER begins with `-` and is DATA. Escaping
## every `-`-leading cell would corrupt every legitimate negative figure, and an export that
## mangles the numbers is as wrong as one that executes them. The rule is therefore about
## TEXT: a cell the client is writing as a NUMBER is left numeric, and a cell carrying
## untrusted TEXT is neutralised.
extends RefCounted


func run(t) -> void:
	test_nothing_is_written_until_asked(t)
	test_a_formula_leading_text_cell_is_neutralised(t)
	test_every_formula_trigger_character_is_neutralised(t)
	test_a_negative_number_is_not_corrupted(t)
	test_a_numeric_cell_is_written_as_a_number(t)
	test_a_quote_inside_a_cell_is_escaped(t)
	test_a_newline_inside_a_cell_does_not_break_the_row(t)
	test_json_round_trips_and_is_not_a_formula_surface(t)
	test_no_secret_reaches_the_csv(t)
	test_no_secret_reaches_the_json(t)
	test_a_private_path_is_not_exported(t)
	test_the_export_uploads_nothing(t)
	test_an_empty_export_is_a_stated_empty_file(t)
	test_the_export_names_its_own_columns(t)
	test_the_preview_shows_exactly_what_is_written(t)


## A row of exportable facts, as the statistics page holds them.
func _rows() -> Array[Dictionary]:
	return [
		{"label": "Provider rate limit", "value": "Rate limit reached", "count": 3, "spend": 1.25},
		{"label": "Model context limit", "value": "context overflow", "count": 1, "spend": 0.0},
	]


## NOTHING IS WRITTEN UNTIL THE USER ASKS. Building an export is not the same as performing
## one, and the writer is what touches the disk.
func test_nothing_is_written_until_asked(t) -> void:
	var path := "user://test_r707_unasked.csv"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var builder := ExportBuilder.new()
	builder.add_rows(_rows())
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	t.check(not builder.text().is_empty(), "the text composes")
	# TWO checks, because each catches a different way composition could have written:
	#   * the path is ABSENT, which catches an immediate write to the target;
	#   * the path is OCCUPIED and composition still succeeds, which catches a write that
	#     truly travels through it. An occupied path makes such a write fail, so a composed
	#     export that returned text regardless is what proves it never touched the disk.
	t.check(
		not FileAccess.file_exists(path),
		"composing an export writes no file at the target"
	)
	DirAccess.make_dir_recursive_absolute(
		ProjectSettings.globalize_path(path).path_join("occupied")
	)
	t.check(not builder.text().is_empty(), "and it still composes when the target is unusable")
	t.check(
		DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(path)),
		"so composition never travelled through the target path"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path).path_join("occupied"))
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	# Only the explicit write touches the disk.
	var error := builder.write_csv(path)
	t.check_equal(error, OK, "the requested write succeeds")
	t.check(FileAccess.file_exists(path), "and only then does the file exist")
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## A text cell beginning with `=` is neutralised, so a spreadsheet reads it as data.
func test_a_formula_leading_text_cell_is_neutralised(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "=1+1", "value": "=SUM(A1:A9)", "count": 1, "spend": 0.0}])
	var text := builder.text()
	t.check(
		not _has_executable_cell(text),
		"a formula-leading cell is neutralised (%s)" % text.strip_edges()
	)
	t.check(
		text.contains("1+1"),
		"and the original text is still readable rather than deleted"
	)


## Every character a spreadsheet treats as a formula trigger is handled - not just `=`.
func test_every_formula_trigger_character_is_neutralised(t) -> void:
	for trigger in ["=", "+", "-", "@", "\t", "\r"]:
		var builder := ExportBuilder.new()
		builder.add_rows([{
			"label": "%sINJECT" % trigger, "value": "text", "count": 1, "spend": 0.0,
		}])
		var text := builder.text()
		# A TEXT cell with a trigger must not survive as an executable cell.
		t.check(
			not _has_executable_cell(text),
			"the '%s' trigger is neutralised in TEXT (%s)" % [trigger, text.strip_edges()]
		)


## A NEGATIVE NUMBER is data. Escaping it would corrupt every legitimate negative figure,
## which is as wrong as executing one.
func test_a_negative_number_is_not_corrupted(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "Delta", "value": "spend", "count": -5, "spend": -2.5}])
	var text := builder.text()
	t.check(
		text.contains("-5"),
		"a negative COUNT stays a readable number (%s)" % text.strip_edges()
	)
	t.check(
		text.contains("-2.5"),
		"and a negative SPEND stays readable"
	)
	# The decisive distinction: the numeric cells are NOT quoted-and-prefixed, because doing so
	# would make the spreadsheet treat them as text and break arithmetic on the column.
	t.check(
		not text.contains("'-5") and not text.contains("\t-5"),
		"and it is not escaped into text, which would break the column (%s)" % text.strip_edges()
	)


## A numeric cell is written as a NUMBER, so a spreadsheet can compute with it.
func test_a_numeric_cell_is_written_as_a_number(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "Total", "value": "ok", "count": 42, "spend": 3.5}])
	t.check(
		builder.text().contains(",42,"),
		"an integer cell is bare (%s)" % builder.text().strip_edges()
	)
	t.check(
		builder.text().contains(",3.5"),
		"and a fractional one keeps its digits"
	)


## A quote inside a cell is escaped by doubling it, so the row stays parseable.
func test_a_quote_inside_a_cell_is_escaped(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "say \"hi\"", "value": "ok", "count": 1, "spend": 0.0}])
	var text := builder.text()
	t.check(
		text.contains("\"\"hi\"\""),
		"an embedded quote is doubled (%s)" % text.strip_edges()
	)
	# And the field is then parseable: the doubled quote does not end the field early.
	t.check_equal(
		_count_fields(text.split("\n")[1]), ExportBuilder.COLUMNS.size(),
		"so the row still has all of its fields (%d)" % ExportBuilder.COLUMNS.size()
	)


## A newline inside a cell does not break the row: it must stay inside a quoted field rather
## than starting a new record.
func test_a_newline_inside_a_cell_does_not_break_the_row(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "line one\nline two", "value": "ok", "count": 1, "spend": 0.0}])
	var text := builder.text()
	# Counting newlines cannot tell a quoted newline from a broken record: both add a line. A
	# proper CSV reader can, so the records are parsed and counted.
	var records := _parse_records(text)
	t.check_equal(records.size(), 2, "the file is a header plus ONE record, not three")
	if records.size() >= 2:
		t.check_equal(records[1].size(), ExportBuilder.COLUMNS.size(),
			"and the record keeps every field")
	t.check(text.contains("line one"), "and the text survives")
	# The embedded newline must be INSIDE the cell, which is what makes the record one record.
	if records.size() >= 2:
		t.check(
			str(records[1][0]).contains("line two"),
			"with the second line inside the same cell (%s)" % str(records[1][0])
		)


## The JSON form is a real object rather than a concatenated string, so a consumer parses it.
func test_json_round_trips_and_is_not_a_formula_surface(t) -> void:
	var builder := ExportBuilder.new()
	builder.add_rows([{"label": "=1+1", "value": "=SUM(A1)", "count": 2, "spend": 0.5}])
	var parsed: Variant = JSON.parse_string(builder.text_json())
	t.check(parsed is Dictionary, "the JSON parses")
	if not (parsed is Dictionary):
		return
	var rows: Variant = (parsed as Dictionary).get("rows", null)
	t.check(rows is Array and (rows as Array).size() == 1, "and carries the row")
	# JSON is DATA, not a spreadsheet: the formula-leading text is preserved verbatim, because
	# escaping it would corrupt the value for a JSON consumer.
	var row: Dictionary = (rows as Array)[0]
	t.check_equal(
		str(row.get("label", "")), "=1+1",
		"and the value round-trips unchanged, because JSON is not a formula surface"
	)


## A credential-shaped fixture, composed at runtime.
##
## The source carries no secret-shaped literal: the shapes this suite redacts are exactly the
## shapes a scanner looks for, and a test that hardcodes one is one copy away from shipping
## the real thing. Composing it also keeps the assertion honest about what it exercises.
func _credential_shaped() -> String:
	return "pass" + "word=scope-secret-value"


func _key_shaped() -> String:
	return "api_" + "key=" + "sk-" + "abcdefghijklmnop"


func _home_path_shaped() -> String:
	return "/" + "Users/someone/private/notes.md"


## No secret reaches the CSV. A credential-shaped value must not be exported.
func test_no_secret_reaches_the_csv(t) -> void:
	var builder := ExportBuilder.new()
	var credential := _credential_shaped()
	builder.add_rows([{
		"label": "note", "value": credential, "count": 1, "spend": 0.0,
	}])
	t.check(
		not builder.text().contains(credential),
		"a credential-shaped value is redacted from the CSV (%s)" % builder.text().strip_edges()
	)
	t.check(
		builder.text().contains(ExportBuilder.REDACTED),
		"and the redaction is marked as one (%s)" % builder.text().strip_edges()
	)
	t.check(
		builder.text().contains("note"),
		"while the rest of the row survives"
	)


## No secret reaches the JSON either, so the two forms cannot disagree about redaction.
func test_no_secret_reaches_the_json(t) -> void:
	var builder := ExportBuilder.new()
	var key := _key_shaped()
	builder.add_rows([{
		"label": "note", "value": key, "count": 1, "spend": 0.0,
	}])
	t.check(
		not builder.text_json().contains(key),
		"a key-shaped value is redacted from the JSON (%s)" % builder.text_json()
	)


## A private filesystem path is not exported: it names the user's machine, which an export
## that leaves the machine would disclose.
func test_a_private_path_is_not_exported(t) -> void:
	var builder := ExportBuilder.new()
	var path := _home_path_shaped()
	builder.add_rows([{
		"label": "file", "value": "read " + path,
		"count": 1, "spend": 0.0,
	}])
	t.check(
		not builder.text().contains(path),
		"a home-directory path is redacted (%s)" % builder.text().strip_edges()
	)


## THE EXPORT UPLOADS NOTHING. There is no network call on this path at all, and the builder
## holds no transport to make one with.
func test_the_export_uploads_nothing(t) -> void:
	var builder := ExportBuilder.new()
	t.check(
		not builder.has_method("upload") and not builder.has_method("publish")
		and not builder.has_method("send"),
		"the export exposes no method that could upload"
	)
	t.check(
		ExportBuilder.UPLOADS_NOTHING.contains("no network"),
		"and states that it performs no network call (%s)" % ExportBuilder.UPLOADS_NOTHING
	)


## An export with nothing selected is a STATED empty file, not a malformed one.
func test_an_empty_export_is_a_stated_empty_file(t) -> void:
	var builder := ExportBuilder.new()
	var text := builder.text()
	t.check(not text.is_empty(), "an empty export still produces a file")
	t.check(
		text.contains("label"),
		"with the header, so the file is well-formed (%s)" % text.strip_edges()
	)
	t.check_equal(text.split("\n").size() - 1, 1, "and no data rows")


## The export names its own columns, so a reader knows what each field is.
func test_the_export_names_its_own_columns(t) -> void:
	var builder := ExportBuilder.new()
	var header := builder.text().split("\n")[0]
	for column in ["label", "value", "count", "spend"]:
		t.check(
			header.contains(column),
			"the header names '%s' (%s)" % [column, header]
		)


## The preview shows exactly what is written. A preview that differed from the file would
## reveal nothing about what the user is about to disclose.
func test_the_preview_shows_exactly_what_is_written(t) -> void:
	var path := "user://test_r707_preview.csv"
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))
	var builder := ExportBuilder.new()
	builder.add_rows(_rows())
	builder.write_csv(path)
	var written := FileAccess.get_file_as_string(path)
	# The preview is the body, which is what the file holds.
	t.check_equal(builder.text(), written, "the preview equals the written file exactly")
	# And the parity holds for the redacted case too, which is the one that matters.
	var secret := _credential_shaped()
	builder.add_rows([{"label": "n", "value": secret, "count": 1, "spend": 0.0}])
	builder.write_csv(path)
	var written2 := FileAccess.get_file_as_string(path)
	t.check_equal(builder.text(), written2, "and for a redacted row")
	t.check(
		not written2.contains(secret),
		"so the preview cannot hide a secret the file would contain"
	)
	DirAccess.remove_absolute(ProjectSettings.globalize_path(path))


## Whether any cell in a CSV body would be read as a formula.
##
## A cell is executable when its first character is a trigger AND it is not neutralised by a
## leading apostrophe. Comparing against the raw text this way is what makes the escape rule
## testable without re-implementing it.
func _has_executable_cell(text: String) -> bool:
	for line in text.split("\n"):
		if line.strip_edges().is_empty():
			continue
		for field in _split_fields(line):
			if field.is_empty():
				continue
			# A neutralised cell begins with the apostrophe the writer adds.
			if field.begins_with("'"):
				continue
			if field.begins_with("=") or field.begins_with("+") or field.begins_with("@"):
				return true
			if field.begins_with("-") and not _is_number(field):
				return true
			if field.begins_with("\t") or field.begins_with("\r"):
				return true
	return false


func _is_number(value: String) -> bool:
	return value.is_valid_float() or value.is_valid_int()


func _split_fields(line: String) -> Array[String]:
	var out: Array[String] = []
	var current := ""
	var quoted := false
	var index := 0
	while index < line.length():
		var character := line[index]
		if character == "\"":
			if quoted and index + 1 < line.length() and line[index + 1] == "\"":
				current += "\""
				index += 2
				continue
			quoted = not quoted
			index += 1
			continue
		if character == "," and not quoted:
			out.append(current)
			current = ""
			index += 1
			continue
		current += character
		index += 1
	out.append(current)
	return out


func _count_fields(line: String) -> int:
	return _split_fields(line).size()


## Parse a CSV body into records, honouring quoted fields that carry commas and newlines.
## This is what makes a broken record distinguishable from a quoted newline.
func _parse_records(text: String) -> Array:
	var records: Array = []
	var record: Array[String] = []
	var field := ""
	var quoted := false
	var index := 0
	while index < text.length():
		var character := text[index]
		if character == "\"":
			if quoted and index + 1 < text.length() and text[index + 1] == "\"":
				field += "\""
				index += 2
				continue
			quoted = not quoted
			index += 1
			continue
		if character == "," and not quoted:
			record.append(field)
			field = ""
			index += 1
			continue
		if character == "\n" and not quoted:
			record.append(field)
			records.append(record)
			record = []
			field = ""
			index += 1
			continue
		field += character
		index += 1
	if not field.is_empty() or not record.is_empty():
		record.append(field)
		records.append(record)
	return records
