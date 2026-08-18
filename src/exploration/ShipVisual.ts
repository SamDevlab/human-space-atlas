import {
  BoxGeometry,
  Cartesian3,
  Color,
  ColorBlendMode,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
  Entity,
  EllipsoidGeometry,
  GeometryInstance,
  Matrix3,
  Matrix4,
  Material,
  ModelGraphics,
  PerInstanceColorAppearance,
  PointPrimitive,
  PointPrimitiveCollection,
  Primitive,
  PrimitiveCollection,
  Polyline,
  PolylineCollection,
  Quaternion,
  ShadowMode,
  Viewer,
} from 'cesium'
import { getShipBasis } from './flightModel'
import { computeOrbitalLighting } from './OrbitalLighting'

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
  private readonly viewer: Viewer
  private readonly collection: PrimitiveCollection
  private readonly components: VisualComponent[] = []
  private readonly engines: PointPrimitiveCollection
  private readonly enginePrimitives: PointPrimitive[] = []
  private readonly trailCollection: PolylineCollection
  private readonly trails: Polyline[] = []
  private readonly trailMaterials: Material[] = []
  private readonly modelEntity: Entity
  private readonly modelPosition: ConstantPositionProperty
  private readonly modelOrientation: ConstantProperty
  private readonly modelColor: ConstantProperty
  private readonly modelBlendAmount: ConstantProperty
  private visible = false
  private sunlightFactor = 1
  private lastLightingSampleAt = 0

  constructor(viewer: Viewer) {
    this.viewer = viewer
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

    this.modelPosition = new ConstantPositionProperty(Cartesian3.ZERO)
    this.modelOrientation = new ConstantProperty(Quaternion.IDENTITY)
    this.modelColor = new ConstantProperty(Color.WHITE)
    this.modelBlendAmount = new ConstantProperty(0)
    this.modelEntity = viewer.entities.add(new Entity({
      name: 'HSA Explorer · Voyager probe',
      show: false,
      position: this.modelPosition,
      orientation: this.modelOrientation,
      model: new ModelGraphics({
        scale: new ConstantProperty(58),
        minimumPixelSize: new ConstantProperty(120),
        // Voyager Probe (B) includes embedded NASA texture images and PBR
        // materials. Keep the model's original painted/gold/black livery while
        // allowing a subtle blue eclipse tint when Earth occludes the Sun.
        uri: new ConstantProperty('/assets/voyager-probe-b.glb'),
        color: this.modelColor,
        colorBlendMode: new ConstantProperty(ColorBlendMode.MIX),
        colorBlendAmount: this.modelBlendAmount,
        runAnimations: new ConstantProperty(false),
        shadows: new ConstantProperty(ShadowMode.ENABLED),
      }),
    }))
  }

  update(position: Cartesian3, orientation: Quaternion, snapshot: ShipVisualSnapshot): void {
    const now = performance.now()
    if (now - this.lastLightingSampleAt >= 200) {
      this.lastLightingSampleAt = now
      this.sunlightFactor = computeOrbitalLighting(this.viewer.clock.currentTime, position).sunlight
      const shadow = 1 - this.sunlightFactor
      this.modelColor.setValue(new Color(
        0.42 + this.sunlightFactor * 0.58,
        0.56 + this.sunlightFactor * 0.44,
        0.72 + this.sunlightFactor * 0.28,
        1,
      ))
      this.modelBlendAmount.setValue(shadow * 0.58)
    }

    const rotation = Matrix3.fromQuaternion(orientation, new Matrix3())
    const shipMatrix = Matrix4.fromRotationTranslation(rotation, position, new Matrix4())
    for (const component of this.components) Matrix4.multiply(shipMatrix, component.localMatrix, component.primitive.modelMatrix)
    this.modelPosition.setValue(position)
    this.modelOrientation.setValue(orientation)
    this.modelEntity.show = this.visible

    const enginePositions = ENGINE_OFFSETS.map((offset) => Matrix4.multiplyByPoint(shipMatrix, offset, new Cartesian3()))
    const forward = getShipBasis(orientation).forward
    const eclipseBoost = 1 - this.sunlightFactor
    const trailLength = 1_800 + Math.abs(snapshot.throttle) * 5_500 + (snapshot.boost ? 6_000 : 0)
    const engineSize = 14 + Math.abs(snapshot.throttle) * 20 + (snapshot.boost ? 18 : 0) + eclipseBoost * 5
    const engineColor = snapshot.boost
      ? Color.fromCssColorString('#d8fbff')
      : Color.fromCssColorString(eclipseBoost > 0.5 ? '#79e8ff' : '#5edcff')
    for (let i = 0; i < this.enginePrimitives.length; i += 1) {
      const engine = this.enginePrimitives[i]
      engine.position = enginePositions[i]
      engine.pixelSize = engineSize
      engine.color = engineColor
      this.trails[i].positions = [enginePositions[i], Cartesian3.subtract(enginePositions[i], Cartesian3.multiplyByScalar(forward, trailLength, new Cartesian3()), new Cartesian3())]
      this.trails[i].width = 2 + Math.abs(snapshot.throttle) * 4 + (snapshot.boost ? 3 : 0)
    }
    for (const material of this.trailMaterials) {
      const alpha = snapshot.boost ? 0.85 : 0.45 + eclipseBoost * 0.18
      material.uniforms.color = engineColor.withAlpha(alpha)
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.setProceduralVisible(false)
    this.modelEntity.show = visible
  }

  destroy(viewer: Viewer): void {
    viewer.entities.remove(this.modelEntity)
    viewer.scene.primitives.remove(this.collection)
  }

  private setProceduralVisible(visible: boolean): void {
    this.collection.show = visible
    for (const component of this.components) component.primitive.show = visible
    for (const engine of this.enginePrimitives) engine.show = visible
    for (const trail of this.trails) trail.show = visible
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
