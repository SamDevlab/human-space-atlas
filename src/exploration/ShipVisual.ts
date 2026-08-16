import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  Material,
  PerInstanceColorAppearance,
  PointPrimitive,
  PointPrimitiveCollection,
  Primitive,
  PrimitiveCollection,
  Polyline,
  PolylineCollection,
  Quaternion,
  Viewer,
} from 'cesium'
import { getShipBasis } from './flightModel'

export const SHIP_VISUAL_LENGTH_METERS = 3_200

const ENGINE_OFFSETS = [
  new Cartesian3(-1_180, -235, -145),
  new Cartesian3(-1_180, 235, -145),
  new Cartesian3(-1_180, -235, 145),
  new Cartesian3(-1_180, 235, 145),
]

interface VisualComponent {
  primitive: Primitive
  localMatrix: Matrix4
}

export interface ShipVisualSnapshot {
  throttle: number
  boost: boolean
}

/**
 * Procedural HSA Explorer Mk II. Its visual scale is intentionally
 * larger than physical spacecraft scale so the player can read the silhouette
 * in a third-person orbital composition. Physics remains in meters.
 */
export class ShipVisual {
  private readonly collection: PrimitiveCollection
  private readonly components: VisualComponent[] = []
  private readonly engines: PointPrimitiveCollection
  private readonly enginePrimitives: PointPrimitive[] = []
  private readonly trailCollection: PolylineCollection
  private readonly trails: Polyline[] = []
  private readonly trailMaterials: Material[] = []
  private visible = false

  constructor(viewer: Viewer) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection())
    const hull = Color.fromCssColorString('#1d3446')
    const hullHighlight = Color.fromCssColorString('#365a72')
    const wing = Color.fromCssColorString('#122736')
    const detail = Color.fromCssColorString('#4cd8ed')

    this.addBox(new Cartesian3(2_300, 560, 480), new Cartesian3(-20, 0, 0), hull)
    this.addBox(new Cartesian3(760, 760, 320), new Cartesian3(760, 0, 70), hullHighlight)
    this.addEllipsoid(new Cartesian3(930, 370, 300), new Cartesian3(700, 0, 55), hullHighlight)
    this.addEllipsoid(new Cartesian3(470, 245, 150), new Cartesian3(430, 0, 290), Color.fromCssColorString('#b8e8ff'))
    this.addBox(new Cartesian3(1_050, 1_900, 120), new Cartesian3(-300, -1_060, 0), wing, Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -0.16, new Quaternion()))
    this.addBox(new Cartesian3(1_050, 1_900, 120), new Cartesian3(-300, 1_060, 0), wing, Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, 0.16, new Quaternion()))
    this.addBox(new Cartesian3(460, 150, 760), new Cartesian3(-780, 0, 400), hullHighlight)
    this.addBox(new Cartesian3(520, 720, 180), new Cartesian3(-1_020, 0, 0), Color.fromCssColorString('#10202d'))
    this.addBox(new Cartesian3(1_000, 60, 70), new Cartesian3(120, -300, 55), detail)
    this.addBox(new Cartesian3(1_000, 60, 70), new Cartesian3(120, 300, 55), detail)

    this.engines = this.collection.add(new PointPrimitiveCollection())
    for (const offset of ENGINE_OFFSETS) {
      this.enginePrimitives.push(this.engines.add({
        position: offset.clone(),
        pixelSize: 20,
        color: Color.CYAN,
        outlineColor: Color.WHITE,
        outlineWidth: 1,
        show: false,
      }))
    }

    this.trailCollection = this.collection.add(new PolylineCollection())
    for (let i = 0; i < ENGINE_OFFSETS.length; i += 1) {
      const material = Material.fromType('Color', { color: Color.CYAN.withAlpha(0.55) })
      this.trailMaterials.push(material)
      this.trails.push(this.trailCollection.add({ positions: [Cartesian3.ZERO, Cartesian3.ZERO], width: 4, material, show: false }))
    }
  }

  update(position: Cartesian3, orientation: Quaternion, snapshot: ShipVisualSnapshot): void {
    const rotation = Matrix3.fromQuaternion(orientation, new Matrix3())
    const shipMatrix = Matrix4.fromRotationTranslation(rotation, position, new Matrix4())
    for (const component of this.components) Matrix4.multiply(shipMatrix, component.localMatrix, component.primitive.modelMatrix)

    const enginePositions = ENGINE_OFFSETS.map((offset) => Matrix4.multiplyByPoint(shipMatrix, offset, new Cartesian3()))
    const forward = getShipBasis(orientation).forward
    const trailLength = 1_800 + Math.abs(snapshot.throttle) * 5_500 + (snapshot.boost ? 6_000 : 0)
    const engineSize = 14 + Math.abs(snapshot.throttle) * 20 + (snapshot.boost ? 18 : 0)
    const engineColor = snapshot.boost ? Color.fromCssColorString('#c9f7ff') : Color.fromCssColorString('#5edcff')
    for (let i = 0; i < this.enginePrimitives.length; i += 1) {
      const engine = this.enginePrimitives[i]
      engine.position = enginePositions[i]
      engine.pixelSize = engineSize
      engine.color = engineColor
      this.trails[i].positions = [enginePositions[i], Cartesian3.subtract(enginePositions[i], Cartesian3.multiplyByScalar(forward, trailLength, new Cartesian3()), new Cartesian3())]
      this.trails[i].width = 2 + Math.abs(snapshot.throttle) * 4 + (snapshot.boost ? 3 : 0)
    }
    for (const material of this.trailMaterials) material.uniforms.color = engineColor.withAlpha(snapshot.boost ? 0.85 : 0.45)
    this.collection.show = this.visible
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.collection.show = visible
    for (const component of this.components) component.primitive.show = visible
    for (const engine of this.enginePrimitives) engine.show = visible
    for (const trail of this.trails) trail.show = visible
  }

  destroy(viewer: Viewer): void {
    viewer.scene.primitives.remove(this.collection)
  }

  private addBox(dimensions: Cartesian3, translation: Cartesian3, color: Color, rotation = Quaternion.IDENTITY): void {
    const geometry = BoxGeometry.fromDimensions({ dimensions, vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT })
    this.addGeometry(geometry, translation, rotation, color)
  }

  private addEllipsoid(radii: Cartesian3, translation: Cartesian3, color: Color): void {
    const geometry = new EllipsoidGeometry({ radii, vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT, stackPartitions: 8, slicePartitions: 12 })
    this.addGeometry(geometry, translation, Quaternion.IDENTITY, color)
  }

  private addGeometry(geometry: BoxGeometry | EllipsoidGeometry, translation: Cartesian3, rotation: Quaternion, color: Color): void {
    const instance = new GeometryInstance({ geometry, attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) } })
    const primitive = this.collection.add(new Primitive({
      geometryInstances: instance,
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }),
      asynchronous: false,
      show: true,
    }))
    this.components.push({ primitive, localMatrix: Matrix4.fromTranslationQuaternionRotationScale(translation, rotation, Cartesian3.ONE, new Matrix4()) })
  }
}
