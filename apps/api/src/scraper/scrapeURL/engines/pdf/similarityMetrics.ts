export function computeSimilarityMetrics(
  a: string,
  b: string,
): {
  jaccard: number;
  precision: number;
  recall: number;
  f1: number;
} {
  const normalise = (s: string) =>
    s
      .replace(/[#*_`\[\]()>|~\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const wordsA = new Set(normalise(a).split(" ").filter(Boolean));
  const wordsB = new Set(normalise(b).split(" ").filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) {
    return { jaccard: 1, precision: 1, recall: 1, f1: 1 };
  }
  if (wordsA.size === 0 || wordsB.size === 0) {
    return { jaccard: 0, precision: 0, recall: 0, f1: 0 };
  }

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const jaccard = intersection / (wordsA.size + wordsB.size - intersection);
  const precision = intersection / wordsA.size;
  const recall = intersection / wordsB.size;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  return {
    jaccard: Math.round(jaccard * 1000) / 1000,
    precision: Math.round(precision * 1000) / 1000,
    recall: Math.round(recall * 1000) / 1000,
    f1: Math.round(f1 * 1000) / 1000,
  };
}
