import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsInt, Min } from 'class-validator';

export class RequestPartsDto {
  @ApiProperty({
    description: 'Part numbers the client will upload',
    type: [Number],
    example: [1, 2, 3],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
