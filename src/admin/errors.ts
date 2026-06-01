// src/admin/errors.ts

export type AdminErrorCode =
  | 'provider_not_found'
  | 'account_not_found'
  | 'account_conflict'
  | 'login_timeout'

export class AdminError extends Error {
  constructor(
    public code: AdminErrorCode,
    message: string,
    public detail?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'AdminError'
  }
}
