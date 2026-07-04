import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "tabRole" })
export class RoleEntity {
  @PrimaryColumn({ type: "varchar", length: 140 })
  name!: string;

  @Column({ type: "smallint", default: 0 })
  disabled!: number;
}
