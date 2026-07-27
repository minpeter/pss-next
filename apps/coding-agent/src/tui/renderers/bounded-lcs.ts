const MAX_LCS_CELLS = 65_536;

const matchCommonEdges = (
  left: readonly string[],
  right: readonly string[]
): Array<readonly [number, number]> => {
  const prefix: Array<readonly [number, number]> = [];
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    prefix.push([index, index]);
    index += 1;
  }

  const suffix: Array<readonly [number, number]> = [];
  let leftIndex = left.length - 1;
  let rightIndex = right.length - 1;
  while (
    leftIndex >= index &&
    rightIndex >= index &&
    left[leftIndex] === right[rightIndex]
  ) {
    suffix.push([leftIndex, rightIndex]);
    leftIndex -= 1;
    rightIndex -= 1;
  }

  suffix.reverse();
  return [...prefix, ...suffix];
};

const exactLcsMatches = (
  left: readonly string[],
  right: readonly string[]
): Array<readonly [number, number]> => {
  const matrix = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      matrix[leftIndex][rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? (matrix[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1
          : Math.max(
              matrix[leftIndex - 1]?.[rightIndex] ?? 0,
              matrix[leftIndex]?.[rightIndex - 1] ?? 0
            );
    }
  }

  const matches: Array<readonly [number, number]> = [];
  let leftIndex = left.length;
  let rightIndex = right.length;
  while (leftIndex > 0 && rightIndex > 0) {
    if (left[leftIndex - 1] === right[rightIndex - 1]) {
      matches.push([leftIndex - 1, rightIndex - 1]);
      leftIndex -= 1;
      rightIndex -= 1;
    } else if (
      (matrix[leftIndex - 1]?.[rightIndex] ?? 0) >=
      (matrix[leftIndex]?.[rightIndex - 1] ?? 0)
    ) {
      leftIndex -= 1;
    } else {
      rightIndex -= 1;
    }
  }

  matches.reverse();
  return matches;
};

export const boundedLcsMatches = (
  left: readonly string[],
  right: readonly string[]
): Array<readonly [number, number]> => {
  if (left.length === 0 || right.length === 0) {
    return [];
  }

  const exceedsBudget = left.length > Math.floor(MAX_LCS_CELLS / right.length);
  return exceedsBudget
    ? matchCommonEdges(left, right)
    : exactLcsMatches(left, right);
};
