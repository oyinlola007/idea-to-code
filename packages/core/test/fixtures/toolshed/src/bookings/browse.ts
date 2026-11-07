// Toolshed is a fictitious app used as the test fixture. Not real code.
export function toolsNearby(radiusKm: number): string[] {
  return radiusKm > 0 ? ['drill', 'ladder'] : [];
}
