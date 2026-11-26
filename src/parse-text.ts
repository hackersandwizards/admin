export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function parseYamlFrontmatter(yaml: string): unknown {
  try {
    return Bun.YAML.parse(yaml);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export function decodePercentEncoding(text: string): string | undefined {
  if (/%(?![\da-f]{2})/i.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}
