import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

/** Assignment of a Role to a User (`parent` = user name). */
@Entity({ name: "tabHasRole" })
@Index(["parent", "role"], { unique: true })
export class HasRoleEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 140 })
  parent!: string; // User name (email)

  @Column({ type: "varchar", length: 140 })
  role!: string;
}
