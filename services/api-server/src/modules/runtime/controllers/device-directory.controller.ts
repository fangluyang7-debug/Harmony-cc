import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { DeviceDirectoryService } from '../../../core/runtime/device-directory.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RuntimeMaintenanceGuard } from '../runtime-maintenance.guard';
import { ok } from '../../../common/dto/api-response.dto';

@Controller('api/v1/runtime/device-directory')
export class DeviceDirectoryController {
  constructor(private readonly directory: DeviceDirectoryService) {}
  @Post('workers')
  @UseGuards(JwtAuthGuard,RuntimeMaintenanceGuard)
  async register(@Body() body: unknown) { return ok(await this.directory.registerWorker(body)); }
  @Get()
  @UseGuards(JwtAuthGuard,RuntimeMaintenanceGuard)
  async list() { return ok(await this.directory.list()); }
  @Post(':deviceId/revoke')
  @UseGuards(JwtAuthGuard,RuntimeMaintenanceGuard)
  async revoke(@Param('deviceId') id: string) { return ok(await this.directory.revoke(id)); }
  @Post(':deviceId/heartbeat')
  async heartbeat(@Param('deviceId') id: string,@Headers('authorization') auth: string,@Body() body: unknown) {
    return ok(await this.directory.heartbeatWorker(id,auth,body));
  }
}
