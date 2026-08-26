import type { BlindedPacket, CalibrationKey } from "./human-calibration-types";

export function validateCalibrationPacketKeys(
  packets: ReadonlyMap<string, BlindedPacket>,
  keys: ReadonlyMap<string, CalibrationKey>
): void {
  const expected = new Set<string>();
  for (const packet of packets.values()) {
    for (const question of packet.questions) {
      expected.add(`${packet.packet_id}:${question.qid}`);
    }
  }
  if (
    keys.size !== expected.size ||
    [...keys.keys()].some((identity) => !expected.has(identity))
  ) {
    throw new TypeError("Human calibration packet/key coverage is invalid.");
  }
}
