/** HTTP metadata must fit Headers' ByteString; full explanations stay in JSON. */
export function asciiHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "-");
}
