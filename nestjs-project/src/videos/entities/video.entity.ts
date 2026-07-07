import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 16, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', nullable: true })
  upload_id: string | null;

  @Column({ type: 'varchar', nullable: true })
  source_key: string | null;

  @Column({ type: 'varchar', nullable: true })
  thumbnail_key: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  error_reason: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // Owning side only: no inverse `Channel.videos` — nothing consumes the reverse
  // relation, and declaring it would force `Video` to be registered in every
  // TypeORM context that loads `Channel` (partial test DataSources break otherwise).
  // The FK + cascade delete are fully defined here.
  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
