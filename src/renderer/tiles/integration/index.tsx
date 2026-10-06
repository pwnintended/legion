import type { TileProps } from '../../layout/types';
import { TileStub } from '../stub';

export default function IntegrationTile(props: TileProps<'integration'>) {
  return <TileStub {...props} />;
}
