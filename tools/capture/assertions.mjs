export function evaluateExpectations(recipe, producerReport) {
  const observed = producerReport?.observedEvents ?? [];
  const results = recipe.expectations.events.map((expected) => {
    const matches = observed.filter(
      (event) => event.type === expected.type && event.tick === expected.tick,
    );
    return {
      kind: 'event-count',
      passed: matches.length === expected.count,
      diagnostic: matches.length === expected.count
        ? null
        : `expected ${expected.count} ${expected.type} event(s) at tick ${expected.tick}, observed ${matches.length}`,
      details: {
        expected: { ...expected },
        observedCount: matches.length,
      },
    };
  });

  if (!recipe.expectations.allowUnexpectedEvents) {
    const expectedKeys = new Set(
      recipe.expectations.events.map((event) => `${event.type}@${event.tick}`),
    );
    const unexpected = observed.filter((event) => !expectedKeys.has(`${event.type}@${event.tick}`));
    results.push({
      kind: 'no-unexpected-events',
      passed: unexpected.length === 0,
      diagnostic: unexpected.length === 0
        ? null
        : `observed unexpected events: ${unexpected.map((event) => `${event.type}@${event.tick}`).join(', ')}`,
      details: { expected: true, observed: unexpected },
    });
  }
  return results;
}
