/**
 * Masks a connection string and its password in a message before a script
 * prints it, so an error that echoes DATABASE_URL never leaks the credential.
 */

export function redactDbUrl(message, databaseUrl) {
  let out = String(message);
  if (!databaseUrl) return out;
  const secrets = [databaseUrl];
  try {
    const { password } = new URL(databaseUrl);
    if (password) secrets.push(password, decodeURIComponent(password));
  } catch {
    // Not a parseable URL: masking the raw string is all we can do.
  }
  for (const s of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("***");
  }
  return out;
}
