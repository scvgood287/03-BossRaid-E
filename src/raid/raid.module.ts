import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { UserService } from 'src/user/user.service';
import { RaidRecord } from './entities/raid.entity';
import { RaidController } from './raid.controller';
import { RaidService } from './raid.service';
import { BullModule } from '@nestjs/bull';
import { RaidConsumer } from './raid.consumer';

@Module({
  imports: [
    TypeOrmModule.forFeature([RaidRecord, User]),
    BullModule.forRootAsync({
      useFactory: () => ({
        redis: {
          host: process.env.REDIS_HOST,
          port: +process.env.REDIS_PORT,
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'playerQueue',
      defaultJobOptions: {
        removeOnFail: true, //실패한 작업 자동 삭제
      },
    }),
  ],
  controllers: [RaidController],
  providers: [RaidService, RaidConsumer, UserService],
})
export class RaidModule {}
