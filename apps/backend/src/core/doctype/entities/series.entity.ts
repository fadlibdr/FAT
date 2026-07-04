import { Column, Entity, PrimaryColumn } from "typeorm";

/** Counter for naming series (e.g. prefix "CUST-" -> current 42). */
@Entity({ name: "tabSeries" })
export class SeriesEntity {
  @PrimaryColumn({ type: "varchar", length: 140 })
  name!: string; // series prefix

  @Column({ type: "integer", default: 0 })
  current!: number;
}
