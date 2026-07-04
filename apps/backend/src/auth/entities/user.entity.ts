import { Column, Entity, PrimaryColumn } from "typeorm";

/** Application user. `name` is the email, mirroring Frappe. */
@Entity({ name: "tabUser" })
export class UserEntity {
  @PrimaryColumn({ type: "varchar", length: 140 })
  name!: string; // email

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "varchar", length: 255, nullable: true })
  full_name!: string | null;

  @Column({ type: "text" })
  password_hash!: string;

  @Column({ type: "smallint", default: 1 })
  enabled!: number;

  @Column({ type: "timestamptz", default: () => "now()" })
  creation!: Date;
}
