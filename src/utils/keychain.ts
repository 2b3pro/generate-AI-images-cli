import { execFileSync } from 'child_process';

/**
 * Retrieve a generic password secret from macOS Keychain by service and/or account name.
 * Returns undefined if not on macOS, if not found, or on any error.
 */
export function getKeychainPassword(service: string, account?: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  try {
    const args = ['find-generic-password', '-s', service, '-w'];
    if (account) {
      args.splice(2, 0, '-a', account);
    }
    const result = execFileSync('/usr/bin/security', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return result || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve an API key by trying:
 * 1. Environment variables (in given order)
 * 2. macOS Keychain (in given order)
 */
export function resolveApiKey(envVarNames: string[], keychainServiceNames?: string[]): string | undefined {
  // 1. Check environment variables
  for (const name of envVarNames) {
    if (process.env[name]?.trim()) {
      return process.env[name]!.trim();
    }
  }

  // 2. Check macOS Keychain
  const services = keychainServiceNames || envVarNames;
  for (const service of services) {
    const fromKeychain = getKeychainPassword(service);
    if (fromKeychain) {
      return fromKeychain;
    }
  }

  return undefined;
}
