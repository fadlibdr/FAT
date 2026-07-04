import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * DocType metadata — the definition of a business object. Managed as a fixed
 * framework table (`tabDocType`). The physical data table for each DocType
 * (`tab<Name>`) is provisioned separately by SchemaSyncService.
 */
@Entity({ name: "tabDocType" })
export class DocTypeEntity {
  @PrimaryColumn({ type: "varchar", length: 140 })
  name!: string;

  @Column({ type: "varchar", length: 140 })
  module!: string;

  @Column({ type: "varchar", length: 140, default: "hash" })
  naming_rule!: string;

  @Column({ type: "smallint", default: 0 })
  istable!: number;

  @Column({ type: "smallint", default: 0 })
  is_submittable!: number;

  @Column({ type: "varchar", length: 140, nullable: true })
  title_field!: string | null;

  @Column({ type: "timestamptz", default: () => "now()" })
  creation!: Date;

  @Column({ type: "timestamptz", default: () => "now()" })
  modified!: Date;
}
