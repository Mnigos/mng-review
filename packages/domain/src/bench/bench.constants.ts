export const BENCH_FILE_VERSION = 1
/** A finding matches an expected entry when it is this many lines away or closer. */
export const DEFAULT_LINE_WINDOW = 20
/** `real`: a bug the change has; `intentional`: deliberate code; `false`: a known false alarm. */
export const EXPECTED_LABELS = ['real', 'intentional', 'false'] as const
