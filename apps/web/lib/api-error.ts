/** status 0 means the request never reached the API. */
export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}
