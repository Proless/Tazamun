import pkg from '../package.json' with { type: 'json' };

/** Server version, reported in /v1/info. */
export const VERSION: string = pkg.version;

/**
 * Oldest client version this server accepts (SRS 4.4.1). From 1.0 on it trails the server by one
 * minor release (DEP-27). Before 1.0, raise it whenever the API changes incompatibly.
 */
export const MIN_CLIENT_VERSION = '0.1.0';
