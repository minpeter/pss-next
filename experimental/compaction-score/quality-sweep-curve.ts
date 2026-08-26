export interface QualityCell {
  readonly budget: number;
  readonly correct: number;
  readonly total: number;
}

export interface QualityCurvePoint extends QualityCell {
  readonly retention: number;
}

export interface MatchedQualityPoint {
  readonly piBudget: number;
  readonly pssBudget: number;
  readonly quality: number;
}

interface IsotonicBlock {
  end: number;
  start: number;
  total: number;
  weightedRetention: number;
}

export function isotonicCurve(
  cells: readonly QualityCell[]
): readonly QualityCurvePoint[] {
  const sorted = [...cells].sort((left, right) => left.budget - right.budget);
  const blocks: IsotonicBlock[] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const cell = sorted[index];
    assertCell(cell);
    blocks.push({
      end: index,
      start: index,
      total: cell.total,
      weightedRetention: cell.correct,
    });
    while (blocks.length >= 2) {
      const leftBlock = blocks.at(-2);
      const rightBlock = blocks.at(-1);
      if (leftBlock === undefined || rightBlock === undefined) {
        throw new TypeError("Invalid isotonic block stack.");
      }
      if (blockRetention(leftBlock) <= blockRetention(rightBlock)) {
        break;
      }
      const right = blocks.pop();
      const left = blocks.pop();
      if (left === undefined || right === undefined) {
        throw new TypeError("Invalid isotonic block stack.");
      }
      blocks.push({
        end: right.end,
        start: left.start,
        total: left.total + right.total,
        weightedRetention: left.weightedRetention + right.weightedRetention,
      });
    }
  }

  const fitted = new Array<number>(sorted.length);
  for (const block of blocks) {
    const retention = blockRetention(block);
    for (let index = block.start; index <= block.end; index += 1) {
      fitted[index] = retention;
    }
  }

  return sorted.map((cell, index) => {
    const retention = fitted[index];
    if (retention === undefined) {
      throw new TypeError("Missing fitted quality retention.");
    }
    return { ...cell, retention };
  });
}

export function budgetAtQuality(
  curve: readonly QualityCurvePoint[],
  quality: number
): number | null {
  if (curve.length === 0 || !Number.isFinite(quality)) {
    return null;
  }
  const sorted = [...curve].sort((left, right) => left.budget - right.budget);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  if (quality < first.retention || quality > last.retention) {
    return null;
  }
  if (quality === first.retention) {
    return first.budget;
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const right = sorted[index];
    const left = sorted[index - 1];
    if (right === undefined || left === undefined) {
      throw new TypeError("Invalid sorted quality curve.");
    }
    if (quality > right.retention) {
      continue;
    }
    if (right.retention === left.retention) {
      return left.budget;
    }
    const share =
      (quality - left.retention) / (right.retention - left.retention);
    return left.budget + share * (right.budget - left.budget);
  }
  return last.budget;
}

export function matchQualityCurves(
  pssCells: readonly QualityCell[],
  piCells: readonly QualityCell[],
  targets: readonly number[]
): readonly MatchedQualityPoint[] {
  const pssCurve = isotonicCurve(pssCells);
  const piCurve = isotonicCurve(piCells);
  return targets.flatMap((quality) => {
    const pssBudget = budgetAtQuality(pssCurve, quality);
    const piBudget = budgetAtQuality(piCurve, quality);
    return pssBudget === null || piBudget === null
      ? []
      : [{ piBudget, pssBudget, quality }];
  });
}

function assertCell(cell: QualityCell): void {
  if (
    !Number.isSafeInteger(cell.budget) ||
    cell.budget <= 0 ||
    !Number.isSafeInteger(cell.correct) ||
    cell.correct < 0 ||
    !Number.isSafeInteger(cell.total) ||
    cell.total <= 0 ||
    cell.correct > cell.total
  ) {
    throw new TypeError("Invalid quality curve cell.");
  }
}

function blockRetention(block: IsotonicBlock): number {
  return block.weightedRetention / block.total;
}
