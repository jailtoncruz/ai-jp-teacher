import { Injectable } from '@nestjs/common';
import { Bucket, Storage } from '@google-cloud/storage';
import {
  BucketService,
  CreatePreSignedOptions,
} from '../../../../core/abstract/cloud/bucket.service';
import { EnvironmentService } from '../../../config/environment/environment.service';

@Injectable()
export class GcpBucketService extends BucketService {
  private client: Storage;
  private bucket: Bucket;
  constructor(private environment: EnvironmentService) {
    super();
    this.client = new Storage({
      keyFilename: this.environment.getGoogleCloudKeyPath(),
    });
    this.bucket = this.client.bucket(
      this.environment.getOrThrow('GCP_BUCKET_NAME'),
    );
  }

  async createPresignedPutObject(
    options: CreatePreSignedOptions,
  ): Promise<string> {
    const data = await this.bucket.file(options.object).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: options.expireAt,
      contentType: options.contentType ?? 'application/octet-stream',
    });
    return data[0];
  }

  async createPresignedGetObject(
    options: CreatePreSignedOptions,
  ): Promise<string> {
    const data = await this.bucket.file(options.object).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: options.expireAt,
      // contentType: options.contentType ?? 'application/octet-stream',
    });
    return data[0];
  }
}
