import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { photoDigest, photoSchema } from './photo-attachments.ts';
import { MAX_PHOTOS, MAX_PHOTO_BYTES } from '../src/photo-attachments.ts';
import type { PhotoAttachment } from '../src/photo-attachments.ts';

const references = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(MAX_PHOTOS);

/** Local bodies only; the conversation file remains the authority for retention. */
export class PhotoStore {
  private present = new Set<string>();
  private directory: string;
  private retry?: ReturnType<typeof setTimeout>;
  constructor(directory: string) { this.directory = directory; mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  close(): void { clearTimeout(this.retry); }

  load(input: unknown): unknown {
    if (!input || typeof input !== 'object' || !('messages' in input) || !Array.isArray(input.messages)) return input;
    return { ...input, messages: input.messages.map(item => {
      if (!item || typeof item !== 'object' || !('photoFiles' in item)) return item;
      const { photoFiles, photos: _inline, ...message } = item;
      const digests = references.parse(photoFiles);
      try {
        const photos = digests.map(digest => {
          const path = join(this.directory, digest);
          if (statSync(path).size > MAX_PHOTO_BYTES) throw new Error('Stored photo exceeds current limit');
          const data = readFileSync(path).toString('base64');
          const photo = photoSchema.parse({ mimeType: 'image/jpeg', data });
          if (photoDigest(photo) !== digest) throw new Error('Photo body does not match its reference');
          this.present.add(digest);
          return photo;
        });
        return { ...message, photos, photoDigests: digests };
      } catch {
        // A damaged body or a future stricter image limit must not stop ordinary
        // conversations. Keep retry identity and explicitly request a resend.
        return { ...message, photoDigests: digests, photosExpired: true };
      }
    }) };
  }

  prepare<T extends { messages: { photos?: PhotoAttachment[]; photoDigests?: string[] }[] }>(state: T) {
    const retained = new Set<string>();
    const messages = state.messages.map(item => {
      const { photos, ...message } = item;
      if (!photos?.length) return message;
      const digests = photos.map((photo, index) => {
        const digest = item.photoDigests?.[index] ?? photoDigest(photo);
        // Never derive paths from text or client-provided names.
        references.parse([digest]); retained.add(digest);
        if (!this.present.has(digest)) {
          const path = join(this.directory, digest);
          writeFileSync(`${path}.tmp`, Buffer.from(photo.data, 'base64'), { mode: 0o600 });
          renameSync(`${path}.tmp`, path); this.present.add(digest);
        }
        return digest;
      });
      return { ...message, photoFiles: digests };
    });
    return { state: { ...state, messages }, retained };
  }

  // Run only AFTER the conversation state commits. Interrupted writes leave
  // harmless orphans which the next successful save or restart cleans up.
  cleanup(retained: Set<string>): void {
    clearTimeout(this.retry);
    try {
      for (const name of readdirSync(this.directory)) {
        if (!/^[a-f0-9]{64}(?:\.tmp)?$/.test(name) || retained.has(name)) continue;
        unlinkSync(join(this.directory, name)); this.present.delete(name);
      }
    } catch {
      // Cleanup failure must not turn an already committed message into a failure.
      this.retry = setTimeout(() => this.cleanup(retained), 60_000); this.retry.unref();
    }
  }
}
