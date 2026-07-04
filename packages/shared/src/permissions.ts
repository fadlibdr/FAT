/**
 * Permission model — mirrors Frappe's per-DocType, per-Role permissions.
 */
export enum PermType {
  Read = "read",
  Write = "write",
  Create = "create",
  Delete = "delete",
  Submit = "submit",
  Cancel = "cancel",
  Report = "report",
}

export const ALL_PERM_TYPES: readonly PermType[] = [
  PermType.Read,
  PermType.Write,
  PermType.Create,
  PermType.Delete,
  PermType.Submit,
  PermType.Cancel,
  PermType.Report,
];

/** Roles that bypass all permission checks. */
export const SUPER_ROLES: readonly string[] = ["Administrator", "System Manager"];

/**
 * The effective permission a user has for a DocType, as sent to the frontend so
 * the UI can enable/disable action buttons.
 */
export interface DocTypePermissions {
  read: boolean;
  write: boolean;
  create: boolean;
  delete: boolean;
  submit: boolean;
  cancel: boolean;
  report: boolean;
}

export const NO_PERMISSIONS: DocTypePermissions = {
  read: false,
  write: false,
  create: false,
  delete: false,
  submit: false,
  cancel: false,
  report: false,
};

export const ALL_PERMISSIONS: DocTypePermissions = {
  read: true,
  write: true,
  create: true,
  delete: true,
  submit: true,
  cancel: true,
  report: true,
};
