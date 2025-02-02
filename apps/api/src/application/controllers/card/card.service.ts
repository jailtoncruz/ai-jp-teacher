import { Injectable } from '@nestjs/common';
import { CardType, Flashcard } from '@prisma/client';
import { PrismaService } from '../../../infraestructure/database/prisma/prisma.service';
import { AiChatService } from '../../../core/abstract/cloud/ai-chat.service';
import { GenerateCardDto } from './dto/generate-card.dto';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { TTSQueuePayload } from '../../../../../../packages/shared/dist';
import { VoiceOptionsMap } from '@monorepo/shared/dist/core/constants';
import { LoggerService } from '@monorepo/shared';

type CardTTSPayload = TTSQueuePayload<{
  returnChannel: string;
  cardId: string;
}>;

@Injectable()
export class CardService {
  constructor(
    private prisma: PrismaService,
    private aiService: AiChatService,
    private logger: LoggerService,
    @InjectQueue('tts')
    private ttsQueue: Queue<CardTTSPayload>,
  ) {
    logger.setContext(CardService.name);
    this.generateAudioIfNull();
  }

  async generateAudioIfNull() {
    const cards = await this.prisma.flashcard.findMany({
      where: {
        audioUrl: null,
      },
    });

    await this.addCardToTTSQueue(...cards);
    if (cards.length > 0)
      this.logger.log(`Audio generation queued for ${cards.length} cards.`);
  }

  async generateFlashcards({ quantity, complexity, context }: GenerateCardDto) {
    const hiraganas = await this.prisma.flashcard.findMany({
      where: {
        complexity,
      },
      select: { hiragana: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    this.logger.log(
      `Generating ${quantity} cards with complexity ${complexity}`,
    );

    const prompt = [
      {
        role: 'system',
        content: 'You are a helpful assistant for learning hiragana.',
      },
      {
        role: 'user',
        content: `Generate up to ${quantity} ${complexity < 3 ? 'basic' : ''} words or phrases in hiragana ${context ? `of the context "${context}"` : ''} with a complexity level of ${complexity} (Consider 1 as level N5 and 5 as N1; consider more than 5 to create longer sentences). 
                  The words or phrases need to be different of these list: ${hiraganas.join(',')}
                  Respond in plain JSON format with the following schema, without any markdown or code blocks, return a array of these object:
                  {
                    "hiragana": string,
                    "meaning": string,
                    "type": "WORD" | "PHRASE",
                    "explanation"?: string
                  }`,
      },
    ];

    const aiResponse = await this.aiService.completion(prompt);

    // Step 2: Parse the AI's JSON response
    const suggestions = this.parseAiResponse(aiResponse.message.content);

    const flashcards = [];

    for (const suggestion of suggestions) {
      const existingCard = await this.prisma.flashcard.findUnique({
        where: { hiragana: suggestion.hiragana },
      });

      if (!existingCard) {
        const flashcard = await this.prisma.flashcard.create({
          data: {
            hiragana: suggestion.hiragana,
            meaning: suggestion.meaning,
            type: suggestion.type as CardType,
            complexity: complexity,
            explanation: suggestion.explanation || null,
          },
        });

        await this.addCardToTTSQueue(flashcard);
        flashcards.push(flashcard);
        this.logger.log(`New card generated ${suggestion.hiragana}`);
      } else {
        flashcards.push(existingCard);
        this.logger.log(`Duplicated card ${suggestion.hiragana}`);
      }
    }

    this.logger.log(`${flashcards.length} cards generated.`);

    return flashcards;
  }

  private parseAiResponse(response: string): Array<AiCardDto> {
    try {
      // Parse the response as JSON directly
      return JSON.parse(response);
    } catch (error) {
      console.error('Failed to parse AI response:', error);
      return [];
    }
  }

  async explain(card_id: string) {
    const card = await this.prisma.flashcard.findUnique({
      where: { id: card_id },
      select: { hiragana: true },
    });

    const prompt = [
      {
        role: 'system',
        content: 'You are a helpful assistant for learning japanese.',
      },
      {
        role: 'user',
        content: `Explain me what's mean this "${card.hiragana}"? `,
      },
    ];

    const aiResponse = await this.aiService.completion(prompt);
    return aiResponse.message.content;
  }

  private async addCardToTTSQueue(...cards: Flashcard[]) {
    await this.ttsQueue.addBulk(
      cards.map((card) => ({
        name: card.id,
        data: {
          input: card.hiragana,
          voiceOptions: VoiceOptionsMap.get('ja-JP'),
          extraOptions: {
            folder: 'audio-cards/',
            filename: card.hiragana,
            uploadOptions: {
              basepath: 'audio-cards/',
              contentType: 'audio/mp3',
              public: true,
            },
          },
          output: {
            returnChannel: 'card_tts_completed',
            cardId: card.id,
          },
        },
        opts: {
          attempts: 10,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      })),
    );
  }
}

interface AiCardDto {
  hiragana: string;
  meaning: string;
  type: CardType;
  explanation?: string;
}
