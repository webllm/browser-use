export const rejectRedirectsInFetchOptions = (
  options: RequestInit | null | undefined
): RequestInit => ({
  ...(options ?? {}),
  redirect: 'error',
});

export const createNoRedirectFetch = <T extends (...args: any[]) => any>(
  implementation?: T
): T => {
  const target = (implementation ?? globalThis.fetch) as T;
  return ((input: unknown, init?: Record<string, unknown>) =>
    target(input, {
      ...(init ?? {}),
      redirect: 'error',
    })) as T;
};
