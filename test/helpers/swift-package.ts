import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A two-target package: Core (a dependency) and Feature, plus tests. */
export function fixturePackage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ios-sim-pkg-'))
  writeFileSync(join(dir, 'Package.swift'), `// swift-tools-version: 5.9
import PackageDescription
// .target(name: "Commented")
let package = Package(
  name: "Demo",
  platforms: [.iOS(.v18), .macOS(.v14)],
  products: [.library(name: "DemoKit", targets: ["Feature"])],
  targets: [
    .target(name: "Core"),
    .target(name: "Feature", dependencies: [.target(name: "Core")], path: "Modules/Feature"),
    .testTarget(name: "FeatureTests", dependencies: ["Feature"]),
  ]
)
`)
  mkdirSync(join(dir, 'Sources', 'Core'), { recursive: true })
  mkdirSync(join(dir, 'Modules', 'Feature', 'Views'), { recursive: true })
  mkdirSync(join(dir, 'Tests', 'FeatureTests'), { recursive: true })
  writeFileSync(join(dir, 'Sources', 'Core', 'Badge.swift'), `import SwiftUI
struct Badge: View { var body: some View { Text("}") } }
struct Badge_Previews: PreviewProvider { static var previews: some View { Badge() } }
`)
  writeFileSync(join(dir, 'Modules', 'Feature', 'Views', 'Card.swift'), `import SwiftUI
struct Card: View { var body: some View { Text("card") } }
#Preview("Card \\"light\\"") {
  Card()
    .padding() // a { brace in a comment
}
/* #Preview { Commented() } */
#Preview("Dark", traits: .sizeThatFitsLayout) {
  Card().preferredColorScheme(.dark)
}
`)
  writeFileSync(join(dir, 'Tests', 'FeatureTests', 'T.swift'), '#Preview { NotInATarget() }\n')
  return dir
}
