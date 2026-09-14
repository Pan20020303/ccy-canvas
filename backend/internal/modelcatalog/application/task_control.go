package application

// CreditChargingEnabled distinguishes a successful paid reserve from the
// optional no-charger path, which intentionally performs no balance mutation.
func (s *Service) CreditChargingEnabled() bool { return s != nil && s.credits != nil }

// PublishTaskCancellation runs only after the database committed cancellation
// and refund together. It never makes provider calls or performs a second refund.
func (s *Service) PublishTaskCancellation(userID, logID, nodeID, projectID, serviceType string) {
	if s == nil {
		return
	}
	s.publishTaskEventWithStatus(GenerateRequest{UserID: userID, GenerationLogID: logID, NodeID: nodeID, ProjectID: projectID, ServiceType: serviceType}, nil, nil, 0, "cancelled")
}
