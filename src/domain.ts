export {
  analyze,
  comparisonVector,
  ConflictError,
  lexicographicOrder,
  NotFoundError,
  RULES_VERSION,
  validateScenario,
  ValidationError,
} from "./arbitration"

export function comparisonBitDescription(field: string, position: number): string {
  return field === "IDENTIFIER" ? `ID[${position}]` : field
}
