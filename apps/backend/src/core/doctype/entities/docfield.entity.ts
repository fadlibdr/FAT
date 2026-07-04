import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/**
 * A single field within a DocType. `parent` holds the owning DocType name.
 * Stored in the fixed framework table `tabDocField`.
 */
@Entity({ name: "tabDocField" })
@Index(["parent", "fieldname"], { unique: true })
export class DocFieldEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 140 })
  parent!: string; // DocType name

  @Column({ type: "integer", default: 0 })
  idx!: number;

  @Column({ type: "varchar", length: 140 })
  fieldname!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  label!: string | null;

  @Column({ type: "varchar", length: 60 })
  fieldtype!: string;

  @Column({ type: "text", nullable: true })
  options!: string | null;

  @Column({ type: "varchar", length: 140, nullable: true })
  options_field!: string | null;

  @Column({ type: "smallint", default: 0 })
  reqd!: number;

  @Column({ type: "smallint", default: 0 })
  is_unique!: number;

  @Column({ type: "smallint", default: 0 })
  read_only!: number;

  @Column({ type: "smallint", default: 0 })
  hidden!: number;

  @Column({ type: "smallint", default: 0 })
  in_list_view!: number;

  @Column({ type: "smallint", default: 0 })
  in_standard_filter!: number;

  @Column({ type: "text", nullable: true })
  default_value!: string | null;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ type: "integer", default: 0 })
  permlevel!: number;
}
