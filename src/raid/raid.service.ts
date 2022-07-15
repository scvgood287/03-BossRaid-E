import {
  BadRequestException,
  CACHE_MANAGER,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  MisdirectedException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from 'src/user/entities/user.entity';
import { Connection, Repository } from 'typeorm';
import { RaidEndDto } from './dto/raidEnd.dto';
import { RaidRecord } from './entities/raid.entity';
import { RaidEnterDto } from './dto/raidEnter.dto';
import { EnterBossRaidOption } from 'src/utils/interface/enterBossOption.interface';
import { Cache } from 'cache-manager';
import { TopRankerListDto } from './dto/topRankerList.dto';
import { IRankingInfo } from './rankingInfo.interface';
import { ErrorType } from 'src/utils/responseHandler/error.enum';
import { InjectQueue, Processor } from '@nestjs/bull';
import { Queue } from 'bull';
import AxiosHelper from '../utils/helper/axiosHelper';
import moment from 'moment';
import { UserService } from 'src/user/user.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { IRaidStatus } from './raidStatus.interface';

@Injectable()
@Processor('playerQueue')
export class RaidService {
  constructor(
    @InjectRepository(RaidRecord)
    private readonly raidRecordRepository: Repository<RaidRecord>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    private userService: UserService,
    @InjectQueue('playerQueue')
    private playerQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly connection: Connection,
  ) {}

  /**
   * @작성자 박신영
   * @description 레이드 시작에 관한 비지니스 로직 구현
  */
  async enterBossRaid(raidEnterDto: RaidEnterDto): Promise<EnterBossRaidOption> {
    // queue에 보스 레이드를 시작하려는 유저를 넣습니다.
    let queueData;
    try {
      await this.addPlayerQueue(raidEnterDto);
      queueData = await this.playerQueue.getJobs(['delayed'], 0, 0, false);
      console.log(queueData);
    } catch (e) {
      throw new InternalServerErrorException(ErrorType.bullError.msg);
    }

    // - 레이드 상태 조회
    let redisResult: IRaidStatus;
    let dbResult: IRaidStatus;
    try {
      redisResult = await this.getStatusFromRedis();
      console.log(redisResult);
    } catch (error) {
      dbResult = await this.getStatusFromDB();
    }
    // 레이드 시작 불가능
    if (!redisResult?.canEnter) {
      throw new ForbiddenException(ErrorType.raidStatusForbidden.msg);
    }

    // 레이드 생성
    const { userId, level } = queueData[0].data;
    try {
      const raidData = await this.startBossRaid({ userId, level });
      return raidData;
    } catch (e) {
      throw new InternalServerErrorException(ErrorType.redisError.msg);
    }
  }

  async startBossRaid(raidEnterDto: RaidEnterDto): Promise<EnterBossRaidOption> {
    try {
      const user = await this.userRepository.findOne({ where: { id: raidEnterDto.userId } });
      const newBossRaid = this.raidRecordRepository.create({
        user,
        level: raidEnterDto.level,
        score: 0,
      });

      const raidRecord = await this.raidRecordRepository.save(newBossRaid);
      const setRedis: IRaidStatus = {
        canEnter: false,
        enteredUserId: raidEnterDto.userId,
        raidRecordId: raidRecord.id,
      };
      await this.cacheManager.set('raidStatus', setRedis, { ttl: 180 });

      const enterOption: EnterBossRaidOption = {
        isEntered: true,
        raidRecordId: newBossRaid.id,
      };

      return enterOption;
    } catch (e) {
      throw new InternalServerErrorException(ErrorType.redisError.msg);
    }
  }

  /**
   * @작성자 박신영
   * @description 
   * - 2. Producer
   * - queue에 userId와 level을 추가합니다. (큐에 추가한 데이터를 Job이라고 합니다)
   * - Job은 Consumer(raid.consumer)이 데이터를 처리하는데 필요한 데이터를 포함한 개체입니다. 
   * - option은 지연(생성 시점 부터 작업을 실행할 시기), 시도(작업 실패 시 재시도 횟수)와 같은 옵션 등이 있습니다.
  */
  async addPlayerQueue(playerData: RaidEnterDto) {
    try {
      const player = await this.playerQueue.add('player', playerData, {
        removeOnComplete: true,
        removeOnFail: true,
        delay: 1,
      });
      return player;
    } catch (e) {
      throw new InternalServerErrorException(ErrorType.serverError.msg);
    }
  }

  /**
   * @작성자 김용민
   * @description 레이드 종료에 관한 비지니스 로직 구현
  */
  async endRaid(raidEndDto: RaidEndDto): Promise<void> {
    const { userId, raidRecordId } = raidEndDto;
    let raidStatus: IRaidStatus;

    try {
      raidStatus = await this.cacheManager.get('raidStatus');
      // 레이드 상태가 유효한 값인지 확인
      await this.checkRaidStatus(raidStatus, userId, raidRecordId);

      // S3에서 보스레이드 정보 가져오기
      const response = await AxiosHelper.getInstance();
      const bossRaid = response.data.bossRaids[0];

      const record: RaidRecord = await this.getRaidRecordById(raidRecordId);

      for (const l of bossRaid.levels) {
        if (l.level === record.level) {
          record.score = l.score; // 레이드 기록에 보스 레벨에 따른 스코어 반영
          break;
        }
      }
      const user: User = await this.userService.getUserById(userId);
      user.totalScore = user.totalScore + record.score; // 유저의 totalScore 변경

      await this.saveRaidRecord(user, record); // 레이드 기록 DB에 저장
      await this.cacheManager.del('raidStatus'); // 진행 중인 보스레이드 레디스에서 삭제
      await this.updateUserRanking(userId, record.score); // 유저 랭킹 업데이트
    } catch (error) {
      throw new InternalServerErrorException(ErrorType.serverError.msg);
    }
  }

  /**
   * @작성자 김태영
   * @description 레디스에서 레이드 상태 정보 불러오기
   */
  async getStatusFromRedis(): Promise<IRaidStatus> {
    try {
      const getRedis: IRaidStatus = await this.cacheManager.get('raidStatus'); // 레디스에서 레이드 상태 정보 불러오기

      const result: IRaidStatus = getRedis ? getRedis : { canEnter: true, enteredUserId: null, raidRecordId: null };
      // 상태 정보가 존재하면 입장가능여부 false로 전달, 존재하지 않으면 입장가능여부 true로 전달

      return result;
    } catch (error) {
      throw new InternalServerErrorException(ErrorType.redisError.msg); // 에러시 레디스 에러로 간주합니다
    }
  }

  /**
   * @작성자 김태영
   * @description 데이터베이스에서 최근 레이드 기록을 통해 레이드 상태 정보 불러오기
   */
  async getStatusFromDB(): Promise<IRaidStatus> {
    let raidRecord: RaidRecord;
    try {
      raidRecord = await this.raidRecordRepository
        .createQueryBuilder('record')
        .leftJoinAndSelect('record.user', 'user')
        .orderBy('enterTime', 'DESC')
        .getOne(); // 가장 최근의 레이드 기록을 불러 옵니다
    } catch (error) {
      throw new InternalServerErrorException(ErrorType.databaseServerError.msg); // 에러시 sql 에러
    }

    if (!raidRecord) throw new NotFoundException(ErrorType.raidRecordNotFound.msg); // 레이드 레코드 값이 없을 시 에러

    let bossRaid;
    try {
      const response = await AxiosHelper.getInstance();
      bossRaid = response.data.bossRaids[0]; // static data 불러오기
    } catch (error) {
      throw new MisdirectedException(ErrorType.axiosError.msg);
    }

    const now = moment(); // 현재시간
    const enterTime = moment(raidRecord.enterTime); // 레이드 기록 상의 레이드 시작 시간

    const duration = moment.duration(now.diff(enterTime)).asSeconds(); // moment.js로 현재시간과 레이드 시작시간 간의 차이(초) 계산

    const result: IRaidStatus =
      duration < bossRaid.bossRaidLimitSeconds // 현재시간과 레이드 시작 시간간의 차이가 레이드 제한시간 보다 작을시 레이드가 진행중인 것으로 간주합니다
        ? { canEnter: false, enteredUserId: raidRecord.user.id, raidRecordId: raidRecord.id }
        : { canEnter: true, enteredUserId: null, raidRecordId: null }; // 상태 정보가 존재하면 그대로 전달, 존재하지 않으면 입장여부 true로 전달
    return result;
  }

  /**
   * @작성자 염하늘
   * @description 레이드 랭킹 조회 로직 구현
   */
  async rankRaid(raidRankDto: TopRankerListDto) {
    const user = await this.userService.getUserById(raidRankDto.userId);

    await this.staticDataCaching();

    const topRankerInfoList = await this.getTopRankerList();

    let ranking = 0;
    topRankerInfoList.forEach(element => {
      if (user.id == element.userId) ranking = element.ranking;
    });
    const myRankingInfo: IRankingInfo = {
      ranking: ranking,
      userId: user.id,
      totalScore: user.totalScore,
    };
    return { topRankerInfoList, myRankingInfo };
  }

  /**
   * @작성자 염하늘
   * @description static data redis caching
   */
  public async staticDataCaching() {
    // S3 static data 가져오기
    const staticData = await AxiosHelper.getInstance();
    const bossRaid = staticData.data.bossRaids[0];

    await this.cacheManager.set('bossRaidLimitSeconds', bossRaid.bossRaidLimitSeconds);
    await this.cacheManager.set('level_0', bossRaid.levels[0].score);
    await this.cacheManager.set('level_1', bossRaid.levels[1].score);
    await this.cacheManager.set('level_2', bossRaid.levels[2].score);
  }

  /**
   * @작성자 김태영, 염하늘
   * @description 랭크 탑 10 리스트 불러오기
   */
  async getTopRankerList(): Promise<IRankingInfo[]> {
    //const member = await this.redis.zrevrange('Raid-Rank', 0, 9);
    const allUsers = await this.redis.zrevrange('Rank-Rank',0,-1);
    const resultTotal: IRankingInfo[] = await Promise.all(
      allUsers.map(async el => {
        const score = await this.redis.zscore('Raid-Rank', el);
        const sameScoreList = await this.redis.zrevrangebyscore('Raid-Rank', score, score);
        const firstKey = sameScoreList[0];
        const rank = await this.redis.zrevrank('Raid-Rank', firstKey);

        const result: IRankingInfo = { ranking: rank + 1, userId: Number(el), totalScore: Number(score) };
        return result;
      }),
    );
    return resultTotal;
  }

  /**
   * @작성자 김용민, 김태영
   * @description 레이드 종료 시 레이드 기록과 유저 정보를 트랜잭션으로 DB에 저장
   */
  async saveRaidRecord(user: User, record: RaidRecord): Promise<void> {
    const queryRunner = this.connection.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');
    try {
      await queryRunner.manager.save(user);
      await queryRunner.manager.save(record);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * @작성자 김태영, 염하늘
   * @description 레이드 종료 시 유저 랭킹을 레디스에 업데이트
   */
  async updateUserRanking(userId: number, score: number): Promise<void> {
    try {
      await this.redis.zincrby('Raid-Rank', score, userId);
    } catch (error) {
      throw new InternalServerErrorException(ErrorType.redisError.msg);
    }
  }

  /**
   * @작성자 김용민
   * @description 레이드 상태가 유효한 값인지 확인
   */
  checkRaidStatus(raidStatus: IRaidStatus, userId: number, raidRecordId: number) {
    // raidStatus가 없다면 레이드가 진행 중이지 않거나 시간 초과
    if (!raidStatus) {
      throw new NotFoundException(ErrorType.raidStatusNotFound.msg);
    }

    // 사용자 불일치 or 레이드 기록 불일치
    if (raidStatus.enteredUserId !== userId || raidStatus.raidRecordId !== raidRecordId) {
      throw new BadRequestException(ErrorType.raidStatusBadRequest.msg);
    }
  }

  /**
   * @작성자 김용민
   * @description 레이드 기록 가져오기
   */
  async getRaidRecordById(raidStatusId: number) {
    const record = await this.raidRecordRepository.findOne({ where: { id: raidStatusId } });

    if (!record) {
      throw new NotFoundException(ErrorType.raidRecordNotFound.msg);
    }

    return record;
  }
}
