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

export const SHIP_VISUAL_LENGTH_METERS = 3_200

interface VisualComponent {
  primitive: Primitive
  localMatrix: Matrix4
}

export interface ShipVisualSnapshot {
  throttle: number
  boost: boolean
}

/**
 * Procedural HSA Explorer placeholder. Its visual scale is intentionally
 * larger than physical spacecraft scale so the player can read the silhouette
 * in a third-person orbital composition. Physics remains in meters.
 */
export class ShipVisual {
  private readonly collection: PrimitiveCollection
  private readonly components: VisualComponent[] = []
  private readonly engines: PointPrimitiveCollection
  private readonly leftEngine: PointPrimitive
  private readonly rightEngine: PointPrimitive
  private readonly trailCollection: PolylineCollection
  private readonly trail: Polyline
  private readonly trailMaterial: Material
  private visible = false

  constructor(viewer: Viewer) {
    this.collection = viewer.scene.primitives.add(new PrimitiveCollection())
    this.addBox(new Cartesian3(2_800, 700, 620), new Cartesian3(0, 0, 0), Color.fromCssColorString('#253b4f'))
    this.addEllipsoid(new Cartesian3(1_150, 480, 380), new Cartesian3(850, 0, 30), Color.fromCssColorString('#547b98'))
    this.addEllipsoid(new Cartesian3(530, 280, 170), new Cartesian3(420, 0, 290), Color.fromCssColorString('#b8e8ff'))
    this.addBox(new Cartesian3(1_250, 2_400, 130), new Cartesian3(-350, -1_330, 0), Color.fromCssColorString('#182c3c'), Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, -0.18, new Quaternion()))
    this.addBox(new Cartesian3(1_250, 2_400, 130), new Cartesian3(-350, 1_330, 0), Color.fromCssColorString('#182c3c'), Quaternion.fromAxisAngle(Cartesian3.UNIT_Z, 0.18, new Quaternion()))
    this.addBox(new Cartesian3(560, 150, 900), new Cartesian3(-920, 0, 480), Color.fromCssColorString('#315b77'))

    this.engines = this.collection.add(new PointPrimitiveCollection())
    this.leftEngine = this.engines.add({ position: Cartesian3.ZERO, pixelSize: 20, color: Color.CYAN, outlineColor: Color.WHITE, outlineWidth: 1, show: false })
    this.rightEngine = this.engines.add({ position: Cartesian3.ZERO, pixelSize: 20, color: Color.CYAN, outlineColor: Color.WHITE, outlineWidth: 1, show: false })

    this.trailCollection = this.collection.add(new PolylineCollection())
    this.trailMaterial = Material.fromType('Color', { color: Color.CYAN.withAlpha(0.55) })
    this.trail = this.trailCollection.add({ positions: [Cartesian3.ZERO, Cartesian3.ZERO], width: 4, material: this.trailMaterial, show: false })
  }

  update(position: Cartesian3, orientation: Quaternion, snapshot: ShipVisualSnapshot): void {
    const rotation = Matrix3.fromQuaternion(orientation, new Matrix3())
    const shipMatrix = Matrix4.fromRotationTranslation(rotation, position, new Matrix4())
    for (const component of this.components) Matrix4.multiply(shipMatrix, component.localMatrix, component.primitive.modelMatrix)

    const left = Matrix4.multiplyByPoint(shipMatrix, new Cartesian3(-1_420, -290, -70), new Cartesian3())
    const right = Matrix4.multiplyByPoint(shipMatrix, new Cartesian3(-1_420, 290, -70), new Cartesian3())
    const back = Matrix4.multiplyByPoint(shipMatrix, new Cartesian3(-1_580, 0, -70), new Cartesian3())
    const forward = Matrix3.multiplyByVector(rotation, Cartesian3.UNIT_X, new Cartesian3())
    const trailLength = 1_800 + Math.abs(snapshot.throttle) * 5_500 + (snapshot.boost ? 6_000 : 0)
    const trailEnd = Cartesian3.subtract(back, Cartesian3.multiplyByScalar(forward, trailLength, new Cartesian3()), new Cartesian3())
    this.leftEngine.position = left
    this.rightEngine.position = right
    this.leftEngine.pixelSize = 14 + Math.abs(snapshot.throttle) * 20 + (snapshot.boost ? 18 : 0)
    this.rightEngine.pixelSize = this.leftEngine.pixelSize
    const engineColor = snapshot.boost ? Color.fromCssColorString('#c9f7ff') : Color.fromCssColorString('#5edcff')
    this.leftEngine.color = engineColor
    this.rightEngine.color = engineColor
    this.trail.positions = [left, trailEnd, right]
    this.trail.width = 2 + Math.abs(snapshot.throttle) * 4 + (snapshot.boost ? 3 : 0)
    this.trailMaterial.uniforms.color = engineColor.withAlpha(snapshot.boost ? 0.85 : 0.45)
    this.collection.show = this.visible
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.collection.show = visible
    for (const component of this.components) component.primitive.show = visible
    this.leftEngine.show = visible
    this.rightEngine.show = visible
    this.trail.show = visible
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
