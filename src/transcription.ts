import Groq, { toFile } from 'groq-sdk';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export async function transcribeAudio(
  audioBuffer: Buffer,
): Promise<string | null> {
  const { GROQ_API_KEY: apiKey } = readEnvFile(['GROQ_API_KEY']);
  if (!apiKey) {
    logger.warn('GROQ_API_KEY not set — voice transcription disabled');
    return null;
  }

  try {
    const groq = new Groq({ apiKey });
    const file = await toFile(audioBuffer, 'voice.ogg', {
      type: 'audio/ogg',
    });
    const result = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3-turbo',
      response_format: 'text',
    });

    const transcript = (result as unknown as string).trim();
    logger.info(
      { chars: transcript.length },
      'Voice transcription complete',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    return null;
  }
}
