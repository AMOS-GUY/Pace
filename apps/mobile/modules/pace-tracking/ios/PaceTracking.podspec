Pod::Spec.new do |s|
  s.name           = 'PaceTracking'
  s.version        = '0.1.0'
  s.summary        = 'PACE native GPS recording service with a durable sample journal'
  s.description    = 'Core Location recording, background operation and crash-safe journaling for PACE.'
  s.author         = 'PACE'
  s.homepage       = 'https://github.com/AMOS-GUY/Pace'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
