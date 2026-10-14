/** Resample whole question clusters, keeping repetitions dependent. */
export function clusterBootstrap({ questionIds, valuesByQuestion, seed, iterations = 2000, confidence = 0.95 }) {
  if (!Array.isArray(questionIds) || !questionIds.length || new Set(questionIds).size !== questionIds.length ||
      !Number.isInteger(seed) || !Number.isInteger(iterations) || iterations < 1 || !(confidence > 0 && confidence < 1))
    throw new TypeError('invalid cluster bootstrap parameters');
  const clusters = questionIds.map(id => {
    const values = valuesByQuestion?.[id];
    if (!Array.isArray(values) || !values.length || values.some(x => !Number.isFinite(x)))
      throw new TypeError(`invalid values for question ${id}`);
    return values;
  });
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 2 ** 32);
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let sum = 0, count = 0;
    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      for (const value of cluster) { sum += value; count++; }
    }
    draws.push(sum / count);
  }
  draws.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  const quantile = p => {
    const x = p * (draws.length - 1), lo = Math.floor(x), hi = Math.ceil(x);
    return draws[lo] + (draws[hi] - draws[lo]) * (x - lo);
  };
  return { interval: [quantile(tail), quantile(1 - tail)], method: 'question_cluster_percentile',
    seed, iterations, unique_questions: questionIds.length };
}
