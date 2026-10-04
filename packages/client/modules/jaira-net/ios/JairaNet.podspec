# The phone's network module (decision 0013, amended 2026-10-04): JaiRA machines nearby (Bonjour), and
# Tailscale built in — `Tailnet.xcframework`, which `build.mjs ios` makes with gomobile from
# packages/tailnet/mobile. Without the framework the module still builds, saying it has no tailnet.
Pod::Spec.new do |s|
  s.name           = 'JairaNet'
  s.version        = '0.1.0'
  s.summary        = 'JaiRA machines nearby, and Tailscale built in'
  s.description    = s.summary
  s.license        = 'UNLICENSED'
  s.author         = 'JaiRA'
  s.homepage       = 'https://github.com/ofersadgat/JaiRA'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/ofersadgat/JaiRA.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.swift'
  s.vendored_frameworks = 'Tailnet.xcframework' if File.exist?(File.join(__dir__, 'Tailnet.xcframework'))
  s.frameworks = 'Network', 'Security'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
