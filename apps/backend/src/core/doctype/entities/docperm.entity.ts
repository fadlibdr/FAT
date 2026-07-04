import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * A permission rule granting a Role a set of rights on a DocType (`parent`).
 * This is the equivalent of Frappe's DocPerm and doubles as the role-permission
 * table used by PermissionService. Stored in `tabDocPerm`.
 */
@Entity({ name: "tabDocPerm" })
@Index(["parent", "role", "permlevel"], { unique: true })
export class DocPermEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 140 })
  parent!: string; // DocType name

  @Column({ type: "varchar", length: 140 })
  role!: string;

  @Column({ type: "integer", default: 0 })
  permlevel!: number;

  @Column({ type: "smallint", default: 0 })
  can_read!: number;

  @Column({ type: "smallint", default: 0 })
  can_write!: number;

  @Column({ type: "smallint", default: 0 })
  can_create!: number;

  @Column({ type: "smallint", default: 0 })
  can_delete!: number;

  @Column({ type: "smallint", default: 0 })
  can_submit!: number;

  @Column({ type: "smallint", default: 0 })
  can_cancel!: number;

  @Column({ type: "smallint", default: 0 })
  can_report!: number;

  @Column({ type: "smallint", default: 0 })
  if_owner!: number;
}
