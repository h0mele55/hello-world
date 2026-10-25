/** The error body every API route returns: a code the UI translates, and sometimes a detail code. */
export interface ApiError {
  error: string;
  detail?: string;
}

export async function apiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiError>;
    return { error: typeof body.error === 'string' ? body.error : 'INTERNAL', detail: typeof body.detail === 'string' ? body.detail : undefined };
  } catch {
    return { error: 'INTERNAL' };
  }
}
