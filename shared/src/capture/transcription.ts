import type { ProviderUsage } from './interpreter.js'

/**
 * Turning bytes into words, before anything tries to read them.
 *
 * A voice memo and a photograph of a handwritten field ticket are the two
 * things a phone on a jobsite is actually good at producing, and both arrived
 * at the interpreter as a capture with no text. The interpreter is a text
 * pipeline and should stay one, so this seam sits in front of it.
 *
 * Vendor-agnostic on purpose, exactly like `InterpretationProvider`: nothing
 * outside `providers/` imports a model SDK, so the whole path is testable
 * against a scripted double with no network and no key.
 *
 * `handles` exists because the honest answer differs by media. A vision model
 * reads an image or a PDF; it cannot hear anything. A provider that claimed
 * to handle audio and returned an empty string would put a silent, confident
 * blank where a foreman's account of a delay used to be, and the record built
 * on it would look complete. Saying "nothing here can read this" is worth far
 * more than that.
 */
export interface TranscriptionRequest {
  kind: 'photo' | 'voice' | 'document' | 'text' | 'email'
  contentType: string
  bytes: Buffer
  /**
   * What the person typed alongside the recording, if anything.
   *
   * Worth passing even though it is short. A field transcript is mostly
   * proper nouns — a sub's name, a grid line, a submittal number — and the
   * typed note is usually where those are spelled correctly.
   */
  hint?: string
}

export interface TranscriptionResult {
  text: string
  model: string
  usage: ProviderUsage
}

export interface TranscriptionProvider {
  readonly name: string
  /** True when this provider can actually read that media. Never optimistic. */
  handles(contentType: string): boolean
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
}

/**
 * The line between "read this" and "describe this".
 *
 * A photograph of a field ticket is a document with handwriting on it and
 * what is wanted is the words. A photograph of a cracked slab has no words
 * and what is wanted is what it shows. Asking for the wrong one produces
 * confident nonsense either way, so the prompt says which, and the media type
 * alone cannot tell you — a JPEG is both. The capture's own kind decides:
 * somebody filing a photo means the picture, somebody filing a document means
 * the words.
 */
export function transcriptionInstruction(kind: TranscriptionRequest['kind']): string {
  if (kind === 'document') {
    return [
      'Transcribe this document. Return the words that are on it and nothing else:',
      'no summary, no interpretation, no correction of spelling or arithmetic.',
      'Keep the reading order, and keep line breaks where the layout has them.',
      'Where a word is genuinely illegible write [illegible] rather than guessing at it.',
      'A guess that reads as certain is worse than a gap that reads as one.',
    ].join(' ')
  }
  return [
    'Describe what this photograph shows, for somebody who was not there.',
    'Say what is visible: the work, its condition, the trades and materials you can identify,',
    'anything that looks like a defect, an obstruction or a safety issue.',
    'Read out any text in the frame verbatim — a placard, a label, a tag, a sign.',
    'Do not infer causes, assign fault, or say what should be done about it.',
    'If something is unclear, say it is unclear rather than settling on the likeliest answer.',
  ].join(' ')
}
