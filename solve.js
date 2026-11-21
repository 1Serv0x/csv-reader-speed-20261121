// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV reader).
//
// Same answers, exact broken-row policy; the speed comes from scanning with
// indexOf/slice and one small character-class regex instead of building every
// field one character at a time:
//
//   - Whole-record fast path: a record with no quotes and no stray CRs
//     splits on commas as one slice.
//   - Unquoted fields are found with two indexOf scans (next comma, next
//     LF); a CR inside the slice is rare, so it is handled by a slow branch
//     that walks only that slice. The common field is inlined into the main
//     loop, so it costs no call and no result object.
//   - Quoted fields find the closing quote with indexOf, skipping doubled
//     quotes, then slice the raw content once; line breaks inside it are
//     counted in bulk (CRLF counts once) and CRs normalised to LF.
//
// Semantics (mirroring the reference exactly):
//   - U+FEFF at the very start is dropped; records end at LF or CRLF;
//     a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (stray_cr).
//   - A field opening with a quote runs to the next non-doubled quote
//     ("" is one quote, CRLF/lone CR inside is LF); junk after the closing
//     quote is appended as-is (quote_junk when the field ends, only if junk
//     chars were kept); an unterminated quote is a literal and the rest is
//     re-read unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal; fields stay strings.
//   - columns is the first record iff header, else null; rows are padded
//     with "" (short_row, with fields: count) or cut (long_row, with extra:
//     the cut fields) to the first record's width.
//   - errors are {code, line, row} in the order met; line is the 1-based
//     line the record starts on (every LF/CRLF/lone CR inside quotes
//     counted), row is the record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;
const CR = 3;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Shared field result, written by readUnquoted/readQuoted and by the inlined scan.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by
  // LF is dropped (stray_cr). Sets the shared `pos`/`line` past what it read and the field result.
  // Used for the quote-junk and unterminated-quote paths; the main loop inlines this same scan.
  function readUnquoted(start, init) {
    let value = init;
    let added = 0;
    let p = start;
    for (;;) {
      const iC = text.indexOf(',', p);
      const iL = text.indexOf('\n', p);
      let end;
      let kind;
      if (iC !== -1 && (iL === -1 || iC < iL)) { end = iC; kind = COMMA; }
      else if (iL !== -1) { end = iL; kind = LINE_BREAK; }
      else {
        // To end of text: every CR in it is stray (no LF follows one here).
        if (p < len) {
          const chunk = text.slice(p);
          const crs = chunk.match(/\r/g);
          if (crs !== null) {
            for (let i = 0; i < crs.length; i++) error('stray_cr');
            const stripped = chunk.replace(/\r/g, '');
            value += stripped;
            added += stripped.length;
          } else {
            value += chunk;
            added += chunk.length;
          }
        }
        pos = len;
        fValue = value; fEnded = END; fAdded = added;
        return;
      }
      if (end > p) {
        const chunk = text.slice(p, end);
        const r0 = chunk.indexOf('\r');
        if (r0 === -1) {
          value += chunk;
          added += chunk.length;
        } else {
          // Rare: CRs inside the slice. A CR followed by LF ends the field there (CRLF);
          // any other CR is stray and dropped.
          let q = 0;
          let r = r0;
          for (;;) {
            if (text.charCodeAt(p + r + 1) === 10) {
              if (r > q) {
                const part = chunk.slice(q, r);
                value += part;
                added += part.length;
              }
              pos = p + r + 2;
              line += 1;
              fValue = value; fEnded = LINE_BREAK; fAdded = added;
              return;
            }
            error('stray_cr');
            if (r > q) {
              const part = chunk.slice(q, r);
              value += part;
              added += part.length;
            }
            q = r + 1;
            r = chunk.indexOf('\r', q);
            if (r === -1) {
              if (q < chunk.length) {
                const part = chunk.slice(q);
                value += part;
                added += part.length;
              }
              break;
            }
          }
        }
      }
      if (kind === COMMA) {
        pos = end + 1;
        fValue = value; fEnded = COMMA; fAdded = added;
        return;
      }
      pos = end + 1;
      line += 1;
      fValue = value; fEnded = LINE_BREAK; fAdded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. The closing quote is found with indexOf,
  // skipping doubled quotes; the raw content between the quotes is then sliced once, its line
  // breaks counted in bulk (CRLF counts once) and its CRs normalised to LF.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const rawStart = open + 1;
    let p = rawStart;
    let doubled = false;
    let q;
    for (;;) {
      q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again
        // as unquoted. `line` was never advanced past openLine during the scan, so it is already
        // back where the re-read expects it.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        readUnquoted(open + 1, '"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        p = q + 2;
        continue;
      }
      break;
    }
    let raw = text.slice(rawStart, q);
    const hasLF = raw.indexOf('\n') !== -1;
    const hasCR = raw.indexOf('\r') !== -1;
    if (hasLF || hasCR) {
      // Every LF, CRLF and lone CR inside the quotes is one line.
      const breaks = raw.match(/\r\n|\r|\n/g);
      if (breaks !== null) line += breaks.length;
      if (hasCR) raw = raw.replace(/\r\n?/g, '\n');
    }
    const value = doubled ? raw.replace(/""/g, '"') : raw;
    p = q + 1;
    if (p >= len) {
      pos = p;
      fValue = value; fEnded = END; fAdded = 0;
      return;
    }
    const c = text.charCodeAt(p);
    if (c === 44) {
      pos = p + 1;
      fValue = value; fEnded = COMMA; fAdded = 0;
      return;
    }
    if (c === 10) {
      pos = p + 1;
      line += 1;
      fValue = value; fEnded = LINE_BREAK; fAdded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(p + 1) === 10) {
      pos = p + 2;
      line += 1;
      fValue = value; fEnded = LINE_BREAK; fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(p, value);
    if (fAdded > 0) error('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quotes and no stray CRs splits on commas as one slice.
    // A CR is only excused when it sits right before the LF (CRLF); at end of text any CR is stray.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? len : nl;
    const qi = text.indexOf('"', pos);
    let fields;
    let quoted = false;
    if (qi === -1 || qi >= end) {
      const ri = text.indexOf('\r', pos);
      if (ri === -1 || ri >= end || (nl !== -1 && ri === end - 1)) {
        let segEnd = end;
        if (nl !== -1 && segEnd > pos && text.charCodeAt(segEnd - 1) === 13) segEnd -= 1;
        fields = text.slice(pos, segEnd).split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
      }
    }
    if (fields === undefined) {
      fields = [];
      do {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          readQuoted();
        } else {
          quoted = false;
          // Inline readUnquoted(pos, ''): the common field, no call and no result object.
          let value = '';
          let added = 0;
          let p = pos;
          fieldLoop: for (;;) {
            const iC = text.indexOf(',', p);
            const iL = text.indexOf('\n', p);
            let e2;
            let kind;
            if (iC !== -1 && (iL === -1 || iC < iL)) { e2 = iC; kind = COMMA; }
            else if (iL !== -1) { e2 = iL; kind = LINE_BREAK; }
            else {
              // To end of text: every CR in it is stray (no LF follows one here).
              if (p < len) {
                const chunk = text.slice(p);
                const crs = chunk.match(/\r/g);
                if (crs !== null) {
                  for (let i = 0; i < crs.length; i++) error('stray_cr');
                  const stripped = chunk.replace(/\r/g, '');
                  value += stripped;
                  added += stripped.length;
                } else {
                  value += chunk;
                  added += chunk.length;
                }
              }
              pos = len;
              fValue = value; fEnded = END; fAdded = added;
              break fieldLoop;
            }
            if (e2 > p) {
              const chunk = text.slice(p, e2);
              const r0 = chunk.indexOf('\r');
              if (r0 === -1) {
                value += chunk;
                added += chunk.length;
              } else {
                // Rare: CRs inside the slice. A CR followed by LF ends the field there (CRLF);
                // any other CR is stray and dropped.
                let q = 0;
                let r = r0;
                for (;;) {
                  if (text.charCodeAt(p + r + 1) === 10) {
                    if (r > q) {
                      const part = chunk.slice(q, r);
                      value += part;
                      added += part.length;
                    }
                    pos = p + r + 2;
                    line += 1;
                    fValue = value; fEnded = LINE_BREAK; fAdded = added;
                    break fieldLoop;
                  }
                  error('stray_cr');
                  if (r > q) {
                    const part = chunk.slice(q, r);
                    value += part;
                    added += part.length;
                  }
                  q = r + 1;
                  r = chunk.indexOf('\r', q);
                  if (r === -1) {
                    if (q < chunk.length) {
                      const part = chunk.slice(q);
                      value += part;
                      added += part.length;
                    }
                    break;
                  }
                }
              }
            }
            if (kind === COMMA) {
              pos = e2 + 1;
              fValue = value; fEnded = COMMA; fAdded = added;
              break fieldLoop;
            }
            pos = e2 + 1;
            line += 1;
            fValue = value; fEnded = LINE_BREAK; fAdded = added;
            break fieldLoop;
          }
        }
        fields.push(fValue);
      } while (fEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
