import {
  HUMAN_CALIBRATION_PROTOCOL,
  type HumanLabel,
  type HumanMatch,
  type ViewedArm,
} from "./human-calibration-types";

const MACHINE_ANNOTATOR_PATTERN =
  /^(?:agent|auto|claude|gpt|llm|model)(?::|$)/i;
const HUMAN_ANNOTATOR_PATTERN = /^human:[a-z0-9][a-z0-9._-]*$/i;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseHumanLabels(csv: string): readonly HumanLabel[] {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) {
    throw new TypeError("Human labels CSV is empty.");
  }
  const columns = new Map(header.map((name, index) => [name, index]));
  return rows
    .filter((row) => row.some((value) => value !== ""))
    .map((row) => parseLabel(row, columns));
}

function parseLabel(
  row: readonly string[],
  columns: ReadonlyMap<string, number>
): HumanLabel {
  const field = (name: string): string => {
    const index = columns.get(name);
    const value = index === undefined ? undefined : row[index];
    if (value === undefined || value === "") {
      throw new TypeError(`Human label missing ${name}.`);
    }
    return value;
  };
  const annotatorId = field("annotator_id");
  const annotatorRole = field("annotator_role");
  const confidence = Number(field("confidence"));
  const difficulty = field("difficulty");
  const labeledAtUtc = field("labeled_at_utc");
  const candidateMatch = field("candidate_match");
  const protocolVersion = field("protocol_version");
  const secondsSpent = Number(field("seconds_spent"));
  const viewedArm = field("viewed_arm");

  if (
    MACHINE_ANNOTATOR_PATTERN.test(annotatorId) ||
    !HUMAN_ANNOTATOR_PATTERN.test(annotatorId)
  ) {
    throw new TypeError("Machine annotator identifiers are forbidden.");
  }
  if (
    !(Number.isSafeInteger(confidence) && confidence >= 1 && confidence <= 5)
  ) {
    throw new TypeError(
      "Human confidence must be an integer from 1 through 5."
    );
  }
  if (
    protocolVersion !== HUMAN_CALIBRATION_PROTOCOL ||
    !UTC_TIMESTAMP_PATTERN.test(labeledAtUtc) ||
    !Number.isFinite(Date.parse(labeledAtUtc)) ||
    !(Number.isFinite(secondsSpent) && secondsSpent > 0)
  ) {
    throw new TypeError("Invalid human label provenance.");
  }
  return {
    annotatorId,
    annotatorRole: parseAnnotatorRole(annotatorRole),
    candidateMatch: parseHumanMatch(candidateMatch),
    confidence,
    contentDigest: field("content_digest"),
    difficulty: parseDifficulty(difficulty),
    humanAnswer: field("human_answer"),
    labeledAtUtc,
    packetId: field("packet_id"),
    protocolVersion,
    qid: field("qid"),
    secondsSpent,
    sessionId: field("session_id"),
    viewedArm: parseViewedArm(viewedArm),
  };
}

function parseAnnotatorRole(value: string): HumanLabel["annotatorRole"] {
  switch (value) {
    case "adjudicator":
    case "primary":
    case "secondary":
      return value;
    default:
      throw new TypeError("Invalid human annotator role.");
  }
}

function parseHumanMatch(value: string): HumanMatch {
  switch (value) {
    case "equiv":
    case "exact":
    case "unknown":
    case "wrong":
      return value;
    default:
      throw new TypeError("Invalid human candidate match.");
  }
}

function parseDifficulty(value: string): HumanLabel["difficulty"] {
  switch (value) {
    case "easy":
    case "hard":
    case "med":
      return value;
    default:
      throw new TypeError("Invalid human label difficulty.");
  }
}

function parseViewedArm(value: string): ViewedArm {
  switch (value) {
    case "A":
    case "B":
    case "source":
      return value;
    default:
      throw new TypeError("Invalid viewed arm.");
  }
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let quoted = false;
  let row: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) {
      throw new TypeError("Invalid CSV character index.");
    }
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    switch (character) {
      case '"':
        quoted = true;
        break;
      case ",":
        row.push(field);
        field = "";
        break;
      case "\n":
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        break;
      case "\r":
        if (input[index + 1] === "\n") {
          index += 1;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        break;
      default:
        field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (quoted) {
    throw new TypeError("Unterminated quoted CSV field.");
  }
  return rows;
}
